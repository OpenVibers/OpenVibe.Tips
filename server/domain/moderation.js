'use strict';

/**
 * Moderation of what supporters paid to show: a paid message, a TTS text, a media request, and the
 * name that comes with a tip. The money is never touched here: hiding a paid message does not refund
 * it, and a hidden tip still counts toward its goal and the creator's totals (Billing's books).
 *
 *   moderation   visible  shown as the supporter allowed (privacy.js), through the creator's filter
 *                held     the creator's filter (action hold) matched at settlement: nothing was shown,
 *                         posted or read yet; restore() releases it (overlay alert, chat, TTS, media)
 *                hidden   a creator, moderator or service hid it: queued chat/TTS/media deliveries are
 *                         cancelled, the overlay alert is retracted (connected overlays drop it, replays
 *                         and /state skip it) and public pages leave it out; restore() shows it again on
 *                         pages and overlay state, without replaying what was cancelled
 *
 * Who may moderate a creator's interactions: the creator, their moderators (tip_moderators: added by
 * the creator through a show-once invitation link, or by a service), and services holding
 * tips.interaction.moderate. Every outcome is recorded in tip_moderation_log and published as
 * tips.interaction.moderated (never for simulations): { interaction_id, creator, action, by,
 * moderation_state, cancelled_effects }. The payload names no supporter, message or moderator.
 *
 * hide() and restore() cancel or release what a payment bought (paid messages, TTS, media requests), so
 * they run SERIALIZABLE and lock the interaction row first (the domain's lock order): two moderators
 * acting at once apply one after the other.
 */
const crypto = require('crypto');
const { sql } = require('openvibe-sdk/db');
const { fail, iso, prefixedId, sha256, userSubject, displayName, text, readCursor, cursorOf } = require('../util');
const { publicView } = require('./privacy');
const filter = require('./filter');

const INVITE_RE = /^tmin_[A-Za-z0-9_-]{43}$/;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_MODERATORS = 50;
const CHAT_EFFECTS = ['chat_line', 'paid_message', 'tts', 'media_request'];

function createModeration(ctx) {
    const { db } = ctx;

    // ── Moderators ───────────────────────────────────────────
    const isModerator = async (q, creator, subject) => !!(subject && await q.maybe(sql`SELECT 1 FROM tip_moderators
        WHERE creator_subject = ${creator} AND moderator_subject = ${subject} AND removed_at IS NULL`));
    const listModerators = (q, creator) => q.many(sql`SELECT * FROM tip_moderators WHERE creator_subject = ${creator} AND removed_at IS NULL ORDER BY created_at`);
    /** Creators whose interactions this person moderates (with their handles). */
    const moderatedBy = (q, subject) => q.many(sql`SELECT p.creator_subject, p.handle, p.display_name FROM tip_moderators m
        JOIN creator_tip_profiles p ON p.creator_subject = m.creator_subject WHERE m.moderator_subject = ${subject} AND m.removed_at IS NULL ORDER BY p.handle`);

    /** In q's transaction, or a new one: the creator's row is locked while the limit is counted. */
    function addModerator(q, creator, moderator, { name, addedBy }) {
        const subject = userSubject(moderator, 'moderator');
        if (subject === creator) fail(422, 'tips.invalid_input', 'the creator moderates their own page already');
        return ctx.within(q, async (t) => {
            await ctx.lockCreator(t, creator);
            const count = await t.value(sql`SELECT count(*) FROM tip_moderators WHERE creator_subject = ${creator} AND removed_at IS NULL`);
            if (!(await isModerator(t, creator, subject)) && count >= MAX_MODERATORS) fail(409, 'tips.too_many_moderators', `remove a moderator first (${MAX_MODERATORS} at most)`);
            return presentModerator(await t.one(sql`INSERT INTO tip_moderators (creator_subject, moderator_subject, name, added_by, created_at)
            VALUES (${creator}, ${subject}, ${displayName(name)}, ${addedBy}, ${iso(ctx.now())})
            ON CONFLICT (creator_subject, moderator_subject) DO UPDATE SET removed_at = NULL, name = COALESCE(excluded.name, tip_moderators.name), added_by = excluded.added_by
            RETURNING *`));
        });
    }

    async function removeModerator(creator, moderator) {
        const subject = userSubject(moderator, 'moderator');
        const n = await db.exec(sql`UPDATE tip_moderators SET removed_at = ${iso(ctx.now())} WHERE creator_subject = ${creator} AND moderator_subject = ${subject} AND removed_at IS NULL`);
        return { removed: n > 0 };
    }

    const presentModerator = (m) => (m ? { moderator: { type: 'user', id: m.moderator_subject }, name: m.name || null, added_at: m.created_at } : null);

    // ── Invitations (a show-once link the creator hands to a moderator) ──
    async function createInvite(creator, { createdBy }) {
        const secret = `tmin_${crypto.randomBytes(32).toString('base64url')}`;
        const id = prefixedId('tmin', ctx.now());
        const at = ctx.now();
        await ctx.tx(async (t) => {
            await ctx.lockCreator(t, creator);
            const open = await t.value(sql`SELECT count(*) FROM tip_moderator_invites WHERE creator_subject = ${creator} AND used_at IS NULL AND revoked_at IS NULL
                AND expires_at > ${iso(at)}`);
            if (open >= 10) fail(409, 'tips.too_many_invites', 'revoke an open invitation first (10 at most)');
            await t.exec(sql`INSERT INTO tip_moderator_invites (id, creator_subject, token_hash, created_by, created_at, expires_at)
                VALUES (${id}, ${creator}, ${sha256(secret)}, ${createdBy}, ${iso(at)}, ${iso(at + INVITE_TTL_MS)})`);
        });
        return { id, url: `${ctx.config.baseUrl}/moderate/invite/${secret}`, expires_at: iso(at + INVITE_TTL_MS) };
    }

    /** The open invitation for a presented secret, or null (unknown, used, revoked or expired). */
    async function findInvite(q, secret) {
        if (!INVITE_RE.test(String(secret || ''))) return null;
        const row = await q.maybe(sql`SELECT * FROM tip_moderator_invites WHERE token_hash = ${sha256(secret)}`);
        if (!row || row.used_at || row.revoked_at || Date.parse(row.expires_at) <= ctx.now()) return null;
        return row;
    }

    /** Accept once: the invitation is taken by a conditional update, so two people at once cannot both use it. */
    function acceptInvite(secret, { subject, name }) {
        return ctx.tx(async (t) => {
            const inv = await findInvite(t, secret);
            if (!inv) fail(404, 'tips.invite_not_found', 'this invitation is not valid (it may have been used, revoked or expired)');
            if (inv.creator_subject === subject) fail(422, 'tips.invalid_input', 'this is your own page');
            const n = await t.exec(sql`UPDATE tip_moderator_invites SET used_at = ${iso(ctx.now())}, used_by = ${subject} WHERE id = ${inv.id} AND used_at IS NULL AND revoked_at IS NULL`);
            if (!n) fail(404, 'tips.invite_not_found', 'this invitation is not valid (it may have been used, revoked or expired)');
            return { creator: inv.creator_subject, moderator: await addModerator(t, inv.creator_subject, subject, { name, addedBy: `invite:${inv.id}` }) };
        });
    }

    const openInvites = (q, creator) => q.many(sql`SELECT id, created_at, expires_at FROM tip_moderator_invites WHERE creator_subject = ${creator}
        AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${iso(ctx.now())} ORDER BY created_at`);
    async function revokeInvite(creator, id) {
        const n = await db.exec(sql`UPDATE tip_moderator_invites SET revoked_at = ${iso(ctx.now())} WHERE id = ${String(id || '')} AND creator_subject = ${creator}
            AND used_at IS NULL AND revoked_at IS NULL`);
        return { revoked: n > 0 };
    }

    // ── The filter at settlement ─────────────────────────────
    /**
     * Before anything is shown or read: does the creator's filter (`settings`, profiles.filterOf) match
     * the name or what will be shown or read? Returns { hit, hold }.
     */
    function screen(i, settings) {
        if (!settings || !settings.words.length) return { hit: false, hold: false };
        const req = i.request || {};
        const texts = [i.anonymous ? null : i.supporter_name, i.private_message ? null : i.message, req.tts && req.tts.text];
        const hit = filter.hits(settings, ...texts);
        return { hit, hold: hit && settings.action === 'hold' };
    }

    // ── Outcomes ─────────────────────────────────────────────
    async function record(t, i, action, { role, actor = null, reason = null, cancelled = [] }) {
        await t.exec(sql`INSERT INTO tip_moderation_log (creator_subject, interaction_id, action, by_role, actor, reason, created_at)
            VALUES (${i.creator_subject}, ${i.id}, ${action}, ${role}, ${actor}, ${reason}, ${iso(ctx.now())})`);
        if (!i.test) {
            await ctx.outbox.emit(t, 'tips.interaction.moderated', { type: 'interaction', id: i.id }, {
                interaction_id: i.id, creator: { type: 'user', id: i.creator_subject }, action, by: role,
                moderation_state: i.moderation, cancelled_effects: cancelled,
            });
            ctx.afterCommit(t, () => ctx.outboxKick());
        }
    }

    /**
     * Settlement found a filter match (inside its transaction). markScreened() sets the state before
     * anything is shown (held, or only filtered = masked) and returns the row; recordScreened() logs and
     * publishes it once the settlement's own event is out.
     */
    function markScreened(t, i, verdict) {
        const at = iso(ctx.now());
        return verdict.hold
            ? t.one(sql`UPDATE tip_interactions SET filtered = true, moderation = 'held', moderated_at = ${at}, moderated_by = 'filter', updated_at = ${at} WHERE id = ${i.id} RETURNING *`)
            : t.one(sql`UPDATE tip_interactions SET filtered = true, updated_at = ${at} WHERE id = ${i.id} RETURNING *`);
    }
    function recordScreened(t, i, verdict) {
        return record(t, i, verdict.hold ? 'held' : 'filtered', { role: 'filter', reason: 'blocked_words' });
    }

    /** Who is acting: { role, actor } for the creator, a moderator or a granted service; else null. */
    async function actorFor(q, principal, creator, granted) {
        if (principal.kind === 'service' && granted) return { role: 'service', actor: principal.sub };
        if (principal.kind === 'user' && principal.subject === creator) return { role: 'creator', actor: principal.subject };
        if (principal.kind === 'user' && await isModerator(q, creator, principal.subject)) return { role: 'moderator', actor: principal.subject };
        return null;
    }

    /** Hide from overlays, chat/TTS still to come and public pages. The money is untouched. */
    function hide(i, { role, actor, reason }) {
        const note = text(reason, 'reason', 200);
        return ctx.tx(async (t) => {
            const cur = await ctx.interactions.lock(t, i.id);
            if (cur.moderation === 'hidden') return { interaction: cur, changed: false };
            const at = iso(ctx.now());
            const cancelled = (await t.many(sql`UPDATE interaction_effects SET state = 'cancelled', last_error = 'hidden by moderation', updated_at = ${at}
                WHERE interaction_id = ${cur.id} AND state = 'queued' RETURNING effect`)).map((e) => e.effect).filter((e) => CHAT_EFFECTS.includes(e));
            if (cancelled.length) {
                await t.exec(sql`UPDATE paid_messages SET status = 'cancelled', updated_at = ${at} WHERE interaction_id = ${cur.id} AND status = 'queued'`);
                await t.exec(sql`UPDATE paid_media_requests SET status = 'cancelled', updated_at = ${at} WHERE interaction_id = ${cur.id} AND status = 'queued'`);
            }
            const undelivered = cancelled.length > 0 || cur.moderation === 'held' || cur.payment_state === 'pending';
            const now = await t.one(sql`UPDATE tip_interactions SET moderation = 'hidden', moderated_at = ${at}, moderated_by = ${actor || role},
                    delivery_state = CASE WHEN ${undelivered} AND delivery_state IN ('queued', 'awaiting_payment') THEN 'cancelled' ELSE delivery_state END,
                    updated_at = ${at} WHERE id = ${cur.id} RETURNING *`);
            await ctx.overlays.retract(t, now, await ctx.profiles.filterOf(t, now.creator_subject));
            await record(t, now, 'hidden', { role, actor, reason: note, cancelled });
            return { interaction: now, changed: true, cancelled_effects: cancelled };
        }, ctx.MONEY);
    }

    /**
     * Show it again. Held (never shown) and settled: released now, as settlement would have (overlay
     * alert, chat, TTS, media). Hidden after it was shown: back on pages and in overlay state; what the
     * hide cancelled stays cancelled.
     */
    function restore(i, { role, actor, reason }) {
        const note = text(reason, 'reason', 200);
        return ctx.tx(async (t) => {
            const cur = await ctx.interactions.lock(t, i.id);
            if (cur.moderation === 'visible') return { interaction: cur, changed: false };
            const at = iso(ctx.now());
            // Never shown (held, or hidden before it was): released now, its delivery starting over.
            const neverShown = !(await t.maybe(sql`SELECT 1 FROM overlay_deliveries WHERE interaction_id = ${cur.id} AND kind = 'alert'`));
            const release = cur.payment_state === 'settled' && cur.origin !== 'import' && neverShown;
            const now = await t.one(sql`UPDATE tip_interactions SET moderation = 'visible', moderated_at = ${at}, moderated_by = ${actor || role},
                    delivery_state = CASE WHEN ${release} THEN 'queued' ELSE delivery_state END, updated_at = ${at} WHERE id = ${cur.id} RETURNING *`);
            const settings = await ctx.profiles.filterOf(t, now.creator_subject);
            await ctx.overlays.unretract(t, now, settings);
            if (release) await ctx.interactions.release(t, now, settings);
            await record(t, now, 'restored', { role, actor, reason: note });
            return { interaction: await ctx.interactions.get(t, cur.id), changed: true };
        }, ctx.MONEY);
    }

    /** The moderators' view: what was written (not private things), and what the public sees. */
    function shape(i, settings) {
        const req = i.request || {};
        return {
            id: i.id, kind: i.kind, created_at: i.created_at, settled_at: i.settled_at || null, payment_state: i.payment_state, test: !!i.test,
            moderation: { state: i.moderation, at: i.moderated_at || null, filtered: !!i.filtered },
            supporter_name: i.anonymous || i.erased_at ? 'Anonymous' : (i.supporter_name || 'Someone'),
            amount: i.hide_amount ? null : i.amount,
            message: i.private_message || i.erased_at ? null : (i.message || null),
            tts_text: req.tts && !i.erased_at ? req.tts.text : null,
            media_url: req.media && !i.erased_at ? req.media.url : null,
            public: publicView(i, { filter: settings }),
        };
    }
    const present = async (q, i) => shape(i, await ctx.profiles.filterOf(q, i.creator_subject));

    /** A creator's interactions for review, newest first, keyset-paged. state: held | hidden | visible | all. */
    async function queue(q, creator, { state = 'all', cursor, limit = 50 } = {}) {
        if (!['held', 'hidden', 'visible', 'all'].includes(state)) fail(422, 'tips.invalid_input', 'state must be held, hidden, visible or all');
        const n = Math.min(200, Math.max(1, Number(limit) || 50));
        const cur = cursor ? readCursor(cursor) : null;
        const rows = await q.many(sql`SELECT * FROM tip_interactions WHERE creator_subject = ${creator} AND payment_state IN ('settled', 'reversed', 'pending')
                ${state === 'all' ? sql`` : sql`AND moderation = ${state}`} ${cur ? sql`AND (created_at, id) < (${cur[0]}::timestamptz, ${cur[1]}::text)` : sql``}
            ORDER BY created_at DESC, id DESC LIMIT ${n + 1}`);
        const page = rows.slice(0, n);
        const settings = await ctx.profiles.filterOf(q, creator);
        return { rows: page.map((i) => shape(i, settings)), next_cursor: rows.length > n ? cursorOf(page[n - 1]) : null };
    }

    const log = (q, creator, limit = 100) => q.many(sql`SELECT interaction_id, action, by_role, actor, reason, created_at FROM tip_moderation_log
        WHERE creator_subject = ${creator} ORDER BY id DESC LIMIT ${limit}`);

    /** Held paid messages waiting for review (the dashboard's count). */
    const heldCount = (q, creator) => q.value(sql`SELECT count(*) FROM tip_interactions WHERE creator_subject = ${creator} AND moderation = 'held' AND payment_state = 'settled'`);

    return {
        isModerator, listModerators, moderatedBy, addModerator, removeModerator, presentModerator,
        createInvite, findInvite, acceptInvite, openInvites, revokeInvite,
        screen, markScreened, recordScreened, actorFor, hide, restore, present, queue, log, heldCount,
    };
}

module.exports = { createModeration, INVITE_RE };
