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
 */
const crypto = require('crypto');
const { fail, iso, prefixedId, sha256, userSubject, displayName, text } = require('../util');
const filter = require('./filter');

const INVITE_RE = /^tmin_[A-Za-z0-9_-]{43}$/;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_MODERATORS = 50;
const CHAT_EFFECTS = ['chat_line', 'paid_message', 'tts', 'media_request'];

function createModeration(ctx) {
    const { db } = ctx;

    // ── Moderators ───────────────────────────────────────────
    const isModerator = (creator, subject) => !!(subject && db.prepare('SELECT 1 FROM tip_moderators WHERE creator_subject = ? AND moderator_subject = ? AND removed_at IS NULL').get(creator, subject));
    const listModerators = (creator) => db.prepare('SELECT * FROM tip_moderators WHERE creator_subject = ? AND removed_at IS NULL ORDER BY created_at').all(creator);
    /** Creators whose interactions this person moderates (with their handles). */
    const moderatedBy = (subject) => db.prepare(`SELECT p.creator_subject, p.handle, p.display_name FROM tip_moderators m
        JOIN creator_tip_profiles p ON p.creator_subject = m.creator_subject WHERE m.moderator_subject = ? AND m.removed_at IS NULL ORDER BY p.handle`).all(subject);

    function addModerator(creator, moderator, { name, addedBy }) {
        const subject = userSubject(moderator, 'moderator');
        if (subject === creator) fail(422, 'tips.invalid_input', 'the creator moderates their own page already');
        const count = db.prepare('SELECT COUNT(*) AS n FROM tip_moderators WHERE creator_subject = ? AND removed_at IS NULL').get(creator).n;
        if (!isModerator(creator, subject) && count >= MAX_MODERATORS) fail(409, 'tips.too_many_moderators', `remove a moderator first (${MAX_MODERATORS} at most)`);
        db.prepare(`INSERT INTO tip_moderators (creator_subject, moderator_subject, name, added_by, created_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (creator_subject, moderator_subject) DO UPDATE SET removed_at = NULL, name = COALESCE(excluded.name, name), added_by = excluded.added_by`)
            .run(creator, subject, displayName(name), addedBy, iso(ctx.now()));
        return presentModerator(db.prepare('SELECT * FROM tip_moderators WHERE creator_subject = ? AND moderator_subject = ?').get(creator, subject));
    }

    function removeModerator(creator, moderator) {
        const subject = userSubject(moderator, 'moderator');
        const r = db.prepare('UPDATE tip_moderators SET removed_at = ? WHERE creator_subject = ? AND moderator_subject = ? AND removed_at IS NULL').run(iso(ctx.now()), creator, subject);
        return { removed: r.changes > 0 };
    }

    const presentModerator = (m) => (m ? { moderator: { type: 'user', id: m.moderator_subject }, name: m.name || null, added_at: m.created_at } : null);

    // ── Invitations (a show-once link the creator hands to a moderator) ──
    function createInvite(creator, { createdBy }) {
        const open = db.prepare('SELECT COUNT(*) AS n FROM tip_moderator_invites WHERE creator_subject = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(creator, iso(ctx.now())).n;
        if (open >= 10) fail(409, 'tips.too_many_invites', 'revoke an open invitation first (10 at most)');
        const secret = `tmin_${crypto.randomBytes(32).toString('base64url')}`;
        const id = prefixedId('tmin', ctx.now());
        const at = ctx.now();
        db.prepare('INSERT INTO tip_moderator_invites (id, creator_subject, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, creator, sha256(secret), createdBy, iso(at), iso(at + INVITE_TTL_MS));
        return { id, url: `${ctx.config.baseUrl}/moderate/invite/${secret}`, expires_at: iso(at + INVITE_TTL_MS) };
    }

    /** The open invitation for a presented secret, or null (unknown, used, revoked or expired). */
    function findInvite(secret) {
        if (!INVITE_RE.test(String(secret || ''))) return null;
        const row = db.prepare('SELECT * FROM tip_moderator_invites WHERE token_hash = ?').get(sha256(secret));
        if (!row || row.used_at || row.revoked_at || row.expires_at <= iso(ctx.now())) return null;
        return row;
    }

    function acceptInvite(secret, { subject, name }) {
        return ctx.tx(() => {
            const inv = findInvite(secret);
            if (!inv) fail(404, 'tips.invite_not_found', 'this invitation is not valid (it may have been used, revoked or expired)');
            if (inv.creator_subject === subject) fail(422, 'tips.invalid_input', 'this is your own page');
            db.prepare('UPDATE tip_moderator_invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL').run(iso(ctx.now()), subject, inv.id);
            return { creator: inv.creator_subject, moderator: addModerator(inv.creator_subject, subject, { name, addedBy: `invite:${inv.id}` }) };
        });
    }

    const openInvites = (creator) => db.prepare('SELECT id, created_at, expires_at FROM tip_moderator_invites WHERE creator_subject = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at').all(creator, iso(ctx.now()));
    function revokeInvite(creator, id) {
        return { revoked: db.prepare('UPDATE tip_moderator_invites SET revoked_at = ? WHERE id = ? AND creator_subject = ? AND used_at IS NULL AND revoked_at IS NULL').run(iso(ctx.now()), String(id || ''), creator).changes > 0 };
    }

    // ── The filter at settlement ─────────────────────────────
    /**
     * Inside the settlement transaction, before anything is shown: does the creator's filter match the
     * name or what will be shown or read? Returns { hit, hold }.
     */
    function screen(i) {
        const settings = ctx.profiles.filterOf(i.creator_subject);
        if (!settings || !settings.words.length) return { hit: false, hold: false };
        const req = JSON.parse(i.request || '{}');
        const texts = [i.anonymous ? null : i.supporter_name, i.private_message ? null : i.message, req.tts && req.tts.text];
        const hit = filter.hits(settings, ...texts);
        return { hit, hold: hit && settings.action === 'hold' };
    }

    // ── Outcomes ─────────────────────────────────────────────
    function record(i, action, { role, actor = null, reason = null, cancelled = [] }) {
        db.prepare('INSERT INTO tip_moderation_log (creator_subject, interaction_id, action, by_role, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(i.creator_subject, i.id, action, role, actor, reason, iso(ctx.now()));
        if (!i.test) {
            const now = ctx.interactions.get(i.id);
            ctx.outbox.emit('tips.interaction.moderated', { type: 'interaction', id: i.id }, {
                interaction_id: i.id, creator: { type: 'user', id: i.creator_subject }, action, by: role,
                moderation_state: now.moderation, cancelled_effects: cancelled,
            });
            ctx.afterCommit(() => ctx.outboxKick());
        }
    }

    /**
     * Settlement found a filter match (inside its transaction). markScreened() sets the state before
     * anything is shown (held, or only filtered = masked); recordScreened() logs and publishes it once
     * the settlement's own event is out.
     */
    function markScreened(i, verdict) {
        const at = iso(ctx.now());
        if (verdict.hold) db.prepare("UPDATE tip_interactions SET filtered = 1, moderation = 'held', moderated_at = ?, moderated_by = 'filter', updated_at = ? WHERE id = ?").run(at, at, i.id);
        else db.prepare('UPDATE tip_interactions SET filtered = 1, updated_at = ? WHERE id = ?').run(at, i.id);
    }
    function recordScreened(i, verdict) {
        record(i, verdict.hold ? 'held' : 'filtered', { role: 'filter', reason: 'blocked_words' });
    }

    /** Who is acting: { role, actor } for the creator, a moderator or a granted service; else 403. */
    function actorFor(principal, creator, granted) {
        if (principal.kind === 'service' && granted) return { role: 'service', actor: principal.sub };
        if (principal.kind === 'user' && principal.subject === creator) return { role: 'creator', actor: principal.subject };
        if (principal.kind === 'user' && isModerator(creator, principal.subject)) return { role: 'moderator', actor: principal.subject };
        return null;
    }

    /** Hide from overlays, chat/TTS still to come and public pages. The money is untouched. */
    function hide(i, { role, actor, reason }) {
        const note = text(reason, 'reason', 200);
        return ctx.tx(() => {
            const cur = ctx.interactions.get(i.id);
            if (cur.moderation === 'hidden') return { interaction: cur, changed: false };
            const at = iso(ctx.now());
            const cancelled = db.prepare(`SELECT effect FROM interaction_effects WHERE interaction_id = ? AND state = 'queued' AND effect IN (${CHAT_EFFECTS.map(() => '?').join(',')})`)
                .all(cur.id, ...CHAT_EFFECTS).map((e) => e.effect);
            if (cancelled.length) {
                db.prepare(`UPDATE interaction_effects SET state = 'cancelled', last_error = 'hidden by moderation', updated_at = ? WHERE interaction_id = ? AND state = 'queued'`).run(at, cur.id);
                db.prepare("UPDATE paid_messages SET status = 'cancelled', updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(at, cur.id);
                db.prepare("UPDATE paid_media_requests SET status = 'cancelled', updated_at = ? WHERE interaction_id = ? AND status = 'queued'").run(at, cur.id);
            }
            const undelivered = cancelled.length > 0 || cur.moderation === 'held' || cur.payment_state === 'pending';
            db.prepare(`UPDATE tip_interactions SET moderation = 'hidden', moderated_at = ?, moderated_by = ?,
                    delivery_state = CASE WHEN ? AND delivery_state IN ('queued', 'awaiting_payment') THEN 'cancelled' ELSE delivery_state END, updated_at = ? WHERE id = ?`)
                .run(at, actor || role, undelivered ? 1 : 0, at, cur.id);
            const now = ctx.interactions.get(cur.id);
            ctx.overlays.retract(now);
            record(now, 'hidden', { role, actor, reason: note, cancelled });
            return { interaction: ctx.interactions.get(cur.id), changed: true, cancelled_effects: cancelled };
        });
    }

    /**
     * Show it again. Held (never shown) and settled: released now, as settlement would have (overlay
     * alert, chat, TTS, media). Hidden after it was shown: back on pages and in overlay state; what the
     * hide cancelled stays cancelled.
     */
    function restore(i, { role, actor, reason }) {
        const note = text(reason, 'reason', 200);
        return ctx.tx(() => {
            const cur = ctx.interactions.get(i.id);
            if (cur.moderation === 'visible') return { interaction: cur, changed: false };
            const at = iso(ctx.now());
            // Never shown (held, or hidden before it was): released now, its delivery starting over.
            const neverShown = !db.prepare("SELECT 1 FROM overlay_deliveries WHERE interaction_id = ? AND kind = 'alert'").get(cur.id);
            const release = cur.payment_state === 'settled' && cur.origin !== 'import' && neverShown;
            db.prepare(`UPDATE tip_interactions SET moderation = 'visible', moderated_at = ?, moderated_by = ?,
                    delivery_state = CASE WHEN ? THEN 'queued' ELSE delivery_state END, updated_at = ? WHERE id = ?`).run(at, actor || role, release ? 1 : 0, at, cur.id);
            const now = ctx.interactions.get(cur.id);
            ctx.overlays.unretract(now);
            if (release) ctx.interactions.release(now);
            record(now, 'restored', { role, actor, reason: note });
            return { interaction: ctx.interactions.get(cur.id), changed: true };
        });
    }

    /** The moderators' view: what was written (not private things), and what the public sees. */
    function present(i) {
        const req = JSON.parse(i.request || '{}');
        return {
            id: i.id, kind: i.kind, created_at: i.created_at, settled_at: i.settled_at || null, payment_state: i.payment_state, test: !!i.test,
            moderation: { state: i.moderation, at: i.moderated_at || null, filtered: !!i.filtered },
            supporter_name: i.anonymous || i.erased_at ? 'Anonymous' : (i.supporter_name || 'Someone'),
            amount: i.hide_amount ? null : i.amount,
            message: i.private_message || i.erased_at ? null : (i.message || null),
            tts_text: req.tts && !i.erased_at ? req.tts.text : null,
            media_url: req.media && !i.erased_at ? req.media.url : null,
            public: ctx.view(i),
        };
    }

    /** A creator's interactions for review, newest first. state: held | hidden | visible | all. */
    function queue(creator, { state = 'all', cursor, limit = 50 } = {}) {
        if (!['held', 'hidden', 'visible', 'all'].includes(state)) fail(422, 'tips.invalid_input', 'state must be held, hidden, visible or all');
        const n = Math.min(200, Math.max(1, Number(limit) || 50));
        let cur = null;
        if (cursor) { try { cur = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { fail(422, 'tips.invalid_input', 'bad cursor'); } }
        const rows = db.prepare(`SELECT * FROM tip_interactions WHERE creator_subject = @c AND payment_state IN ('settled', 'reversed', 'pending')
                AND (@s = 'all' OR moderation = @s) AND (@ca IS NULL OR created_at < @ca OR (created_at = @ca AND id < @ci))
            ORDER BY created_at DESC, id DESC LIMIT @n`).all({ c: creator, s: state, ca: cur ? cur[0] : null, ci: cur ? cur[1] : null, n: n + 1 });
        const page = rows.slice(0, n);
        return { rows: page.map(present), next_cursor: rows.length > n ? Buffer.from(JSON.stringify([page[n - 1].created_at, page[n - 1].id])).toString('base64url') : null };
    }

    const log = (creator, limit = 100) => db.prepare('SELECT interaction_id, action, by_role, actor, reason, created_at FROM tip_moderation_log WHERE creator_subject = ? ORDER BY id DESC LIMIT ?').all(creator, limit);

    return {
        isModerator, listModerators, moderatedBy, addModerator, removeModerator, presentModerator,
        createInvite, findInvite, acceptInvite, openInvites, revokeInvite,
        screen, markScreened, recordScreened, actorFor, hide, restore, present, queue, log,
    };
}

module.exports = { createModeration, INVITE_RE };
