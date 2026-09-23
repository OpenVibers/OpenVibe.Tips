'use strict';

/**
 * Creator goals. A goal's total is DERIVED: the sum of its contributions, and a contribution is
 * written only when an interaction settles (never while pending, never for a simulation). A
 * reversal lowers the contribution by what Billing took back from the creator.
 *
 * Which goal a tip counts toward (Live's rule): the goal the supporter picked if it is the
 * creator's and active, otherwise the creator's only active goal; with several active goals and
 * no pick, none.
 *
 * Every change bumps the goal's revision and emits tips.goal.updated plus an overlay delivery.
 */
const { fail, iso, prefixedId, text, positiveInt } = require('../util');
const { safeUrl } = require('./profiles');

function createGoals(ctx) {
    const { db } = ctx;

    const get = (id) => db.prepare('SELECT * FROM tip_goals WHERE id = ?').get(String(id || '')) || null;
    /** Settled contributions, plus the opening amount a goal imported from Live carried over. */
    const totalOf = (goalId) => {
        const r = db.prepare('SELECT COALESCE(SUM(amount - reversed_amount), 0) AS n, COUNT(*) AS c FROM tip_goal_contributions WHERE goal_id = ?').get(goalId);
        const g = db.prepare('SELECT opening_amount FROM tip_goals WHERE id = ?').get(goalId);
        return { n: r.n + ((g && g.opening_amount) || 0), c: r.c, contributions: r.n, opening: (g && g.opening_amount) || 0 };
    };

    function list(creator, { status } = {}) {
        const rows = status
            ? db.prepare('SELECT * FROM tip_goals WHERE creator_subject = ? AND status = ? ORDER BY sort_order, created_at').all(creator, status)
            : db.prepare("SELECT * FROM tip_goals WHERE creator_subject = ? ORDER BY status = 'active' DESC, sort_order, created_at DESC").all(creator);
        return rows;
    }

    function present(g, { contributions = false } = {}) {
        if (!g) return null;
        const t = totalOf(g.id);
        const out = {
            id: g.id, creator: { type: 'user', id: g.creator_subject }, title: g.title, description: g.description || null,
            target_amount: g.target_amount, current_amount: t.n, currency: g.currency, supporters_count: t.c,
            carried_over_amount: t.opening,
            percent: Math.min(100, Math.floor((t.n * 100) / g.target_amount)), reached: !!g.reached_at, reached_at: g.reached_at || null,
            image_url: g.image_url || null, status: g.status, sort_order: g.sort_order, revision: g.revision,
            created_at: g.created_at, updated_at: g.updated_at, closed_at: g.closed_at || null,
        };
        if (contributions) {
            out.contributions = db.prepare(`SELECT c.interaction_id, c.amount, c.reversed_amount, c.created_at, i.supporter_name
                FROM tip_goal_contributions c JOIN tip_interactions i ON i.id = c.interaction_id WHERE c.goal_id = ? ORDER BY c.id DESC LIMIT 200`).all(g.id);
        }
        return out;
    }

    /** Inside a transaction: bump revision, emit the event, queue the overlay delivery. */
    function changed(goalId, reason, { interactionId = null, by = null } = {}) {
        const at = iso(ctx.now());
        db.prepare('UPDATE tip_goals SET revision = revision + 1, updated_at = ? WHERE id = ?').run(at, goalId);
        const g = get(goalId);
        const view = present(g);
        ctx.outbox.emit('tips.goal.updated', { type: 'goal', id: g.id, revision: g.revision }, {
            goal_id: g.id, creator: view.creator, title: g.title, target_amount: g.target_amount, current_amount: view.current_amount,
            currency: g.currency, status: g.status, reached: view.reached, reason, interaction_id: interactionId,
        });
        ctx.overlays.addGoalDelivery(g.creator_subject, view, { reason, interactionId, by, dedupe: `goal:${g.id}:r${g.revision}` });
        return view;
    }

    function fields(input, partial) {
        const out = {};
        if (!partial || input.title !== undefined) {
            const t = text(input.title, 'title', ctx.config.limits.goalTitleChars);
            if (!t) fail(422, 'tips.invalid_input', 'a goal needs a title');
            out.title = t;
        }
        if (input.description !== undefined) out.description = text(input.description, 'description', 1000);
        if (!partial || input.target_amount !== undefined) out.target_amount = positiveInt(input.target_amount, 'target_amount', ctx.config.limits.maxBits);
        if (input.image_url !== undefined) {
            out.image_url = input.image_url ? safeUrl(input.image_url) : null;
            if (input.image_url && !out.image_url) fail(422, 'tips.invalid_input', 'image_url must be an https URL');
        }
        if (input.sort_order !== undefined && input.sort_order !== '') {
            const n = Number(input.sort_order);
            if (!Number.isInteger(n) || n < 0 || n > 1000) fail(422, 'tips.invalid_input', 'sort_order must be 0-1000');
            out.sort_order = n;
        }
        return out;
    }

    function create(creator, input = {}) {
        const f = fields(input, false);
        const count = db.prepare("SELECT COUNT(*) AS n FROM tip_goals WHERE creator_subject = ? AND status = 'active'").get(creator).n;
        if (count >= 20) fail(409, 'tips.too_many_goals', 'close a goal before adding another (20 active at most)');
        return ctx.tx(() => {
            const at = iso(ctx.now());
            const id = prefixedId('tgoal', ctx.now());
            db.prepare(`INSERT INTO tip_goals (id, creator_subject, title, description, target_amount, image_url, status, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, creator, f.title, f.description || null, f.target_amount, f.image_url || null, f.sort_order || 0, at, at);
            return changed(id, 'created');
        });
    }

    function update(goal, input = {}) {
        if (goal.status !== 'active') fail(409, 'tips.goal_closed', 'a closed goal cannot be edited');
        if (input.revision != null && Number(input.revision) !== goal.revision) fail(409, 'tips.revision_conflict', `the goal is at revision ${goal.revision}`);
        const f = fields(input, true);
        const keys = Object.keys(f);
        if (!keys.length) return present(goal);
        return ctx.tx(() => {
            db.prepare(`UPDATE tip_goals SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...f, id: goal.id });
            markReached(goal.id);
            return changed(goal.id, 'updated');
        });
    }

    function close(goal) {
        if (goal.status === 'closed') return present(goal);
        return ctx.tx(() => {
            db.prepare("UPDATE tip_goals SET status = 'closed', closed_at = ? WHERE id = ?").run(iso(ctx.now()), goal.id);
            return changed(goal.id, 'closed');
        });
    }

    function markReached(goalId) {
        const g = get(goalId);
        const reached = totalOf(goalId).n >= g.target_amount;
        if (reached && !g.reached_at) { db.prepare('UPDATE tip_goals SET reached_at = ? WHERE id = ?').run(iso(ctx.now()), goalId); return true; }
        if (!reached && g.reached_at) db.prepare('UPDATE tip_goals SET reached_at = NULL WHERE id = ?').run(goalId);
        return false;
    }

    /** The goal an interaction counts toward, or null. */
    function pick(creator, requestedGoalId) {
        if (requestedGoalId) {
            const g = get(requestedGoalId);
            if (g && g.creator_subject === creator && g.status === 'active') return g;
        }
        const active = db.prepare("SELECT * FROM tip_goals WHERE creator_subject = ? AND status = 'active' LIMIT 2").all(creator);
        return active.length === 1 ? active[0] : null;
    }

    /** Inside the settlement transaction. Simulations never get here. */
    function contribute(interaction, requestedGoalId) {
        const g = pick(interaction.creator_subject, requestedGoalId);
        if (!g) return null;
        const at = iso(ctx.now());
        const r = db.prepare(`INSERT OR IGNORE INTO tip_goal_contributions (goal_id, interaction_id, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(g.id, interaction.id, interaction.amount, at, at);
        if (!r.changes) return null;
        const reachedNow = markReached(g.id);
        return changed(g.id, reachedNow ? 'reached' : 'contribution', { interactionId: interaction.id, by: interaction.supporter_name });
    }

    /** Inside the reversal transaction: take `bits` back off every goal the interaction counted toward. */
    function reverse(interaction, bits) {
        const rows = db.prepare('SELECT * FROM tip_goal_contributions WHERE interaction_id = ?').all(interaction.id);
        const out = [];
        for (const c of rows) {
            const take = Math.min(bits, c.amount - c.reversed_amount);
            if (take <= 0) continue;
            db.prepare('UPDATE tip_goal_contributions SET reversed_amount = reversed_amount + ?, updated_at = ? WHERE id = ?').run(take, iso(ctx.now()), c.id);
            markReached(c.goal_id);
            out.push(changed(c.goal_id, 'reversal', { interactionId: interaction.id }));
        }
        return out;
    }

    return { get, list, present, create, update, close, contribute, reverse, pick, totalOf };
}

module.exports = { createGoals };
