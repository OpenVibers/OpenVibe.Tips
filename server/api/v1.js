'use strict';

/**
 * /api/v1 — Tips' API for services (capability-guarded Network service tokens, audience
 * openvibe.tips) and for people (their Network user token as a Bearer; they act on their own
 * things only). Every POST/PATCH needs an Idempotency-Key. Errors are RFC 9457 problem+json.
 * Amounts are integer Vibes bits; people are SubjectRefs { type: 'user', id: 'usr_…' }.
 *
 * | Method & path                          | Capability (services)        | People                              |
 * |----------------------------------------|------------------------------|-------------------------------------|
 * | GET  /profiles/:creator                | tips.profile.get             | anyone when the page is on; owner   |
 * | PATCH /profiles/:creator               | tips.profile.update          | owner (`me` creates it)             |
 * | GET  /profiles/:creator/totals         | tips.interaction.list        | owner                               |
 * | POST /checkout                         | tips.checkout.create         | the supporter                       |
 * | POST /paid-messages                    | tips.superchat.create        | the supporter                       |
 * | POST /tts-requests                     | tips.tts.request             | the supporter                       |
 * | POST /media-requests                   | tips.media_request.create    | the supporter                       |
 * | GET  /interactions/:id                 | tips.interaction.get         | its creator or supporter            |
 * | GET  /interactions                     | tips.interaction.list        | own receipts; ?as=creator own tips  |
 * | POST /interactions/external            | tips.interaction.record      | —                                   |
 * | GET  /goals?creator=, /goals/:id       | tips.goal.update (private)   | anyone when the page is on; owner   |
 * | POST /goals                            | tips.goal.create             | owner                               |
 * | PATCH /goals/:id                       | tips.goal.update             | owner                               |
 * | POST /goals/:id/close                  | tips.goal.close              | owner                               |
 * | GET|POST /overlay-tokens               | tips.overlay.token.create    | owner                               |
 * | POST /overlay-tokens/:id/revoke        | tips.overlay.token.revoke    | owner                               |
 * | GET  /overlay-configs[/:id]            | tips.overlay.config.get      | owner                               |
 * | POST /overlay-configs, PATCH …/:id     | tips.overlay.config.update   | owner                               |
 * | POST /simulate                         | tips.simulation.run          | owner                               |
 * | GET  /profiles/:creator/supporters     | tips.profile.get (page off)  | anyone when the page shows it; owner|
 * | GET  /me/export, POST /me/erase        | —                            | the supporter's own tips            |
 * | GET  /moderation?creator=&state=       | tips.interaction.moderate    | the creator and their moderators    |
 * | POST /interactions/:id/hide|restore    | tips.interaction.moderate    | the creator and their moderators    |
 * | GET  /moderation/log?creator=          | tips.interaction.moderate    | owner                               |
 * | GET|POST /moderators, POST …/:s/remove | tips.profile.update          | owner                               |
 *
 * Paid requests take `privacy: { anonymous, hide_amount, private_message }` (server/domain/privacy.js).
 * Goals and supporters are answered in their public shape (the creator's page settings) to anyone
 * but the creator and granted services.
 */
const express = require('express');
const { http } = require('openvibe-contracts');
const { TipsError, fail, userSubject, displayName } = require('../util');
const { idempotent } = require('./idempotency');

const CAP = {
    profileGet: 'tips.profile.get',
    profileUpdate: 'tips.profile.update',
    checkout: 'tips.checkout.create',
    superchat: 'tips.superchat.create',
    tts: 'tips.tts.request',
    media: 'tips.media_request.create',
    interactionGet: 'tips.interaction.get',
    interactionList: 'tips.interaction.list',
    interactionRecord: 'tips.interaction.record',
    goalCreate: 'tips.goal.create',
    goalUpdate: 'tips.goal.update',
    goalClose: 'tips.goal.close',
    tokenCreate: 'tips.overlay.token.create',
    tokenRevoke: 'tips.overlay.token.revoke',
    configGet: 'tips.overlay.config.get',
    configUpdate: 'tips.overlay.config.update',
    simulate: 'tips.simulation.run',
    moderate: 'tips.interaction.moderate',   // proposed (docs/capabilities-proposal/), not yet in openvibe-contracts
};

function v1Router({ domain, apiAuth }) {
    const r = express.Router();
    const { db, profiles, goals, interactions, overlays } = domain;
    const idem = idempotent(db, domain.now);

    /** Service with `cap`, or the user who owns `owner` (subject). Anonymous → 401. */
    function allow(req, cap, owner) {
        const p = req.principal;
        if (p.kind === 'anonymous') fail(401, 'token.missing', 'sign in (a Network user token) or present a service token');
        if (p.kind === 'service') { if (!apiAuth.granted(p, cap)) fail(403, 'capability.denied', `${cap} not granted`); return 'service'; }
        if (owner && p.subject === owner) return 'owner';
        fail(403, 'tips.forbidden', 'this belongs to someone else');
        return null;
    }
    /** The creator a call is about: body/query `creator` (subject or handle), or the signed-in user. */
    function creatorOf(req, value, { mustExist = true } = {}) {
        const v = value != null && value !== '' ? value : (req.principal.kind === 'user' ? req.principal.subject : null);
        if (!v) fail(422, 'tips.invalid_input', 'creator is required');
        const ref = typeof v === 'object' ? userSubject(v, 'creator') : String(v);
        const profile = ref === 'me' && req.principal.kind === 'user' ? profiles.bySubject(req.principal.subject) : profiles.resolve(ref);
        if (!profile && mustExist) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        return profile;
    }
    const write = (handler) => [idem, wrap(handler)];

    // ── Profiles ─────────────────────────────────────────────
    r.get('/profiles/:creator', wrap((req, res) => {
        const p = creatorOf(req, req.params.creator);
        const who = req.principal;
        const mine = who.kind === 'user' && who.subject === p.creator_subject;
        const svc = who.kind === 'service' && apiAuth.granted(who, CAP.profileGet);
        // A page that is switched off does not exist for anyone but its creator and granted services.
        if (!p.page_enabled && !mine && !svc) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        const owner = mine || svc;
        const active = goals.list(p.creator_subject, { status: 'active' });
        res.json({ profile: profiles.present(p, { owner }), goals: active.map((g) => (owner ? goals.present(g) : goals.publicGoal(g, p.page))) });
    }));

    /** The supporters page: top supporters and recent public messages, as the creator chose to show them. */
    r.get('/profiles/:creator/supporters', wrap((req, res) => {
        const p = creatorOf(req, req.params.creator);
        const who = req.principal;
        const owner = (who.kind === 'user' && who.subject === p.creator_subject) || (who.kind === 'service' && apiAuth.granted(who, CAP.profileGet));
        if (!owner && (!p.page_enabled || !p.page.supporters_page)) fail(404, 'tips.supporters_not_public', 'this creator does not show their supporters');
        const page = p.page;
        res.json({
            creator: { type: 'user', id: p.creator_subject }, page,
            leaderboard: interactions.leaderboard(p.creator_subject).map((row) => (page.supporters_amounts ? row : { ...row, total: null })),
            recent: page.supporters_messages ? interactions.recentPublic(p.creator_subject).map((v) => (page.supporters_amounts ? v : { ...v, amount: null })) : null,
        });
    }));

    // ── The supporter's own data ─────────────────────────────
    const person = (req) => {
        if (req.principal.kind !== 'user') fail(req.principal.kind === 'anonymous' ? 401 : 403, req.principal.kind === 'anonymous' ? 'token.missing' : 'tips.people_only', 'only the person themselves (a Network user token) can do this');
        return req.principal.subject;
    };
    r.get('/me/export', wrap((req, res) => res.json(interactions.exportFor(person(req)))));
    r.post('/me/erase', ...write((req, res) => res.json(interactions.erase(person(req)))));

    r.patch('/profiles/:creator', ...write((req, res) => {
        const b = req.body || {};
        let p;
        if (req.params.creator === 'me') {
            if (req.principal.kind !== 'user') fail(401, 'token.missing', '`me` needs a user token');
            p = profiles.ensure(req.principal.subject, { username: req.principal.username, displayName: req.principal.name, avatarUrl: req.principal.avatar });
        } else if (req.principal.kind === 'service' && /^usr_/.test(req.params.creator) && !profiles.bySubject(req.params.creator)) {
            allow(req, CAP.profileUpdate);
            // A service opening a profile for a creator names the account projection it knows.
            if (!b.handle) fail(422, 'tips.invalid_input', 'handle is required to create a profile');
            p = profiles.ensure(userSubject(req.params.creator, 'creator'), { username: b.handle, displayName: b.display_name || b.handle, avatarUrl: b.avatar_url });
        } else {
            p = creatorOf(req, req.params.creator);
        }
        allow(req, CAP.profileUpdate, p.creator_subject);
        const out = profiles.update(p.creator_subject, b, { expectedRevision: b.revision });
        res.json({ profile: profiles.present(out, { owner: true }) });
    }));

    r.get('/profiles/:creator/totals', wrap((req, res) => {
        const p = creatorOf(req, req.params.creator);
        allow(req, CAP.interactionList, p.creator_subject);
        res.json({ creator: { type: 'user', id: p.creator_subject }, totals: interactions.totals(p.creator_subject) });
    }));

    // ── Paid requests (checkout / credit) ────────────────────
    function paid(kind, cap) {
        return write(async (req, res) => {
            const b = req.body || {};
            const p = req.principal;
            if (p.kind === 'anonymous') fail(401, 'token.missing', 'sign in to tip');
            let supporter;
            let supporterName;
            if (p.kind === 'service') {
                allow(req, cap);
                supporter = userSubject(b.supporter, 'supporter');
                supporterName = displayName(b.supporter_name) || null;
            } else {
                supporter = p.subject;
                supporterName = displayName(b.supporter_name) || p.name || p.username;
            }
            const profile = creatorOf(req, b.creator);
            const funding = b.pay_with || 'credit';
            const tp = req.ov && req.ov.traceparent;
            const { interaction, replay } = interactions.request(profile, { ...b, kind }, { supporter, supporterName, funding, idempotencyKey: req.idempotencyKey });
            let i = interaction;
            let checkout = null;
            if (!replay) {
                if (funding === 'credit') {
                    const out = await interactions.transfer(i, { traceparent: tp });
                    i = interactions.get(i.id);
                    if (out.refused) {
                        fail(out.refused === 'billing.insufficient_funds' ? 409 : 422, out.refused, out.detail || 'Billing refused the tip', { interaction: interactions.present(i, { viewer: 'supporter' }) });
                    }
                } else {
                    checkout = await interactions.startCheckout(i, { provider: b.provider, traceparent: tp });
                    i = checkout.interaction;
                }
            } else if (i.payment_state === 'failed') {
                fail(409, 'tips.payment_failed', i.failure || 'the payment for this request failed', { interaction: interactions.present(i, { viewer: 'supporter' }) });
            }
            res.status(replay ? 200 : 201).json({
                interaction: interactions.present(i, { viewer: p.kind === 'service' ? 'service' : 'supporter' }),
                checkout_url: i.checkout_url || null, checkout_ref: i.checkout_ref || null,
            });
        });
    }
    r.post('/checkout', ...paid('tip', CAP.checkout));
    r.post('/paid-messages', ...paid('paid_message', CAP.superchat));
    r.post('/tts-requests', ...paid('tts', CAP.tts));
    r.post('/media-requests', ...paid('media_request', CAP.media));

    // ── Interactions ─────────────────────────────────────────
    r.get('/interactions', wrap((req, res) => {
        const p = req.principal;
        const q = req.query;
        let filter;
        if (p.kind === 'service') {
            allow(req, CAP.interactionList);
            filter = {
                creator: q.creator ? (creatorOf(req, q.creator).creator_subject) : null,
                supporter: q.supporter ? userSubject(String(q.supporter), 'supporter') : null,
            };
            if (!filter.creator && !filter.supporter) fail(422, 'tips.invalid_input', 'creator or supporter is required');
        } else if (p.kind === 'user') {
            filter = q.as === 'creator' ? { creator: p.subject } : { supporter: p.subject };
        } else fail(401, 'token.missing', 'sign in to see receipts');
        const out = interactions.list({ ...filter, includeTest: q.include_test !== '0', cursor: q.cursor, limit: q.limit });
        const viewer = p.kind === 'service' ? 'service' : (filter.creator ? 'owner' : 'supporter');
        res.json({ interactions: out.rows.map((i) => interactions.present(i, { viewer })), next_cursor: out.next_cursor });
    }));

    r.get('/interactions/:id', wrap((req, res) => {
        const i = interactions.get(req.params.id);
        const p = req.principal;
        if (!i) fail(404, 'tips.interaction_not_found', 'no such interaction');
        let viewer;
        if (p.kind === 'service') { allow(req, CAP.interactionGet); viewer = 'service'; }
        else if (p.kind === 'user' && p.subject === i.creator_subject) viewer = 'owner';
        else if (p.kind === 'user' && p.subject === i.supporter_subject) viewer = 'supporter';
        else if (p.kind === 'anonymous') fail(401, 'token.missing', 'sign in to see this receipt');
        else fail(404, 'tips.interaction_not_found', 'no such interaction');
        res.json({ interaction: interactions.present(i, { viewer }) });
    }));

    r.post('/interactions/external', ...write((req, res) => {
        allow(req, CAP.interactionRecord);
        const b = req.body || {};
        const profile = creatorOf(req, b.creator);
        const out = interactions.recordExternal(profile, b);
        res.status(out.replay ? 200 : 201).json({ interaction: interactions.present(out.interaction, { viewer: 'service' }), duplicate: out.replay });
    }));

    // ── Goals ────────────────────────────────────────────────
    function goalVisible(req, g) {
        const profile = profiles.bySubject(g.creator_subject);
        if (profile && profile.page_enabled) return true;
        const p = req.principal;
        return (p.kind === 'user' && p.subject === g.creator_subject) || (p.kind === 'service' && apiAuth.granted(p, CAP.goalUpdate));
    }
    const goalOwner = (req, creator) => (req.principal.kind === 'user' && req.principal.subject === creator) || (req.principal.kind === 'service' && apiAuth.granted(req.principal, CAP.goalUpdate));
    r.get('/goals', wrap((req, res) => {
        const profile = creatorOf(req, req.query.creator);
        const sample = { creator_subject: profile.creator_subject };
        if (!goalVisible(req, sample)) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        const status = ['active', 'closed'].includes(req.query.status) ? req.query.status : undefined;
        const full = goalOwner(req, profile.creator_subject);
        res.json({ goals: goals.list(profile.creator_subject, { status }).map((g) => (full ? goals.present(g) : goals.publicGoal(g, profile.page))) });
    }));
    r.get('/goals/:id', wrap((req, res) => {
        const g = goals.get(req.params.id);
        if (!g || !goalVisible(req, g)) fail(404, 'tips.goal_not_found', 'no such goal');
        if (!goalOwner(req, g.creator_subject)) return res.json({ goal: goals.publicGoal(g, profiles.bySubject(g.creator_subject).page) });
        res.json({ goal: goals.present(g, { contributions: true }) });
    }));
    r.post('/goals', ...write((req, res) => {
        const b = req.body || {};
        const profile = creatorOf(req, b.creator);
        allow(req, CAP.goalCreate, profile.creator_subject);
        res.status(201).json({ goal: goals.create(profile.creator_subject, b) });
    }));
    const ownGoal = (req, cap) => {
        const g = goals.get(req.params.id);
        if (!g) fail(404, 'tips.goal_not_found', 'no such goal');
        allow(req, cap, g.creator_subject);
        return g;
    };
    r.patch('/goals/:id', ...write((req, res) => res.json({ goal: goals.update(ownGoal(req, CAP.goalUpdate), req.body || {}) })));
    r.post('/goals/:id/close', ...write((req, res) => res.json({ goal: goals.close(ownGoal(req, CAP.goalClose)) })));

    // ── Overlay tokens and configs ───────────────────────────
    r.get('/overlay-tokens', wrap((req, res) => {
        const profile = creatorOf(req, req.query.creator);
        allow(req, CAP.tokenCreate, profile.creator_subject);
        res.json({ tokens: overlays.listTokens(profile.creator_subject).map(overlays.presentToken) });
    }));
    r.post('/overlay-tokens', ...write((req, res) => {
        const b = req.body || {};
        const profile = creatorOf(req, b.creator);
        allow(req, CAP.tokenCreate, profile.creator_subject);
        const by = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const out = overlays.createToken(profile.creator_subject, { scopes: b.scopes, label: b.label, configId: b.config_id, createdBy: by });
        // Shown once: only its hash is stored. An idempotent replay of this call returns it again to
        // the same caller with the same key, which is the point of the key.
        res.status(201).json({ token: out.token, secret: out.secret, overlay_url: out.overlay_url, events_url: out.events_url });
    }));
    r.post('/overlay-tokens/:id/revoke', ...write((req, res) => {
        const t = overlays.getToken(req.params.id);
        if (!t) fail(404, 'tips.overlay_token_not_found', 'no such overlay token');
        allow(req, CAP.tokenRevoke, t.creator_subject);
        res.json({ token: overlays.revokeToken(t) });
    }));

    r.get('/overlay-configs', wrap((req, res) => {
        const profile = creatorOf(req, req.query.creator);
        allow(req, CAP.configGet, profile.creator_subject);
        res.json({ configs: overlays.listConfigs(profile.creator_subject).map(overlays.presentConfig) });
    }));
    r.get('/overlay-configs/:id', wrap((req, res) => {
        const c = overlays.getConfig(req.params.id);
        if (!c) fail(404, 'tips.overlay_config_not_found', 'no such overlay config');
        allow(req, CAP.configGet, c.creator_subject);
        res.json({ config: overlays.presentConfig(c) });
    }));
    r.post('/overlay-configs', ...write((req, res) => {
        const b = req.body || {};
        const profile = creatorOf(req, b.creator);
        allow(req, CAP.configUpdate, profile.creator_subject);
        res.status(201).json({ config: overlays.createConfig(profile.creator_subject, b) });
    }));
    r.patch('/overlay-configs/:id', ...write((req, res) => {
        const c = overlays.getConfig(req.params.id);
        if (!c) fail(404, 'tips.overlay_config_not_found', 'no such overlay config');
        allow(req, CAP.configUpdate, c.creator_subject);
        res.json({ config: overlays.updateConfig(c, req.body || {}) });
    }));

    // ── Moderation (server/domain/moderation.js) ─────────────
    const { moderation } = domain;
    /** The creator, one of their moderators, or a service with tips.interaction.moderate. */
    function moderatorOf(req, creator, { hideExistence = false } = {}) {
        const p = req.principal;
        if (p.kind === 'anonymous') fail(401, 'token.missing', 'sign in (a Network user token) or present a service token');
        const a = moderation.actorFor(p, creator, p.kind === 'service' && apiAuth.granted(p, CAP.moderate));
        if (a) return a;
        if (p.kind === 'service') fail(403, 'capability.denied', `${CAP.moderate} not granted`);
        if (hideExistence) fail(404, 'tips.interaction_not_found', 'no such interaction');
        fail(403, 'tips.forbidden', 'only the creator and their moderators moderate this page');
        return null;
    }
    r.get('/moderation', wrap((req, res) => {
        const profile = creatorOf(req, req.query.creator);
        moderatorOf(req, profile.creator_subject);
        const out = moderation.queue(profile.creator_subject, { state: req.query.state || 'all', cursor: req.query.cursor, limit: req.query.limit });
        res.json({ creator: { type: 'user', id: profile.creator_subject }, interactions: out.rows, next_cursor: out.next_cursor });
    }));
    r.get('/moderation/log', wrap((req, res) => {
        const profile = creatorOf(req, req.query.creator);
        allow(req, CAP.moderate, profile.creator_subject);
        res.json({ log: moderation.log(profile.creator_subject) });
    }));
    for (const action of ['hide', 'restore']) {
        r.post(`/interactions/:id/${action}`, ...write((req, res) => {
            const i = interactions.get(req.params.id);
            if (!i) fail(404, 'tips.interaction_not_found', 'no such interaction');
            const actor = moderatorOf(req, i.creator_subject, { hideExistence: true });
            const out = moderation[action](i, { ...actor, reason: (req.body || {}).reason });
            res.json({ interaction: moderation.present(out.interaction), changed: out.changed, cancelled_effects: out.cancelled_effects || [] });
        }));
    }
    r.get('/moderators', wrap((req, res) => {
        const profile = creatorOf(req, req.query.creator);
        allow(req, CAP.profileUpdate, profile.creator_subject);
        res.json({ moderators: moderation.listModerators(profile.creator_subject).map(moderation.presentModerator) });
    }));
    r.post('/moderators', ...write((req, res) => {
        const b = req.body || {};
        const profile = creatorOf(req, b.creator);
        allow(req, CAP.profileUpdate, profile.creator_subject);
        const by = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        res.status(201).json({ moderator: moderation.addModerator(profile.creator_subject, b.moderator, { name: b.name, addedBy: by }) });
    }));
    r.post('/moderators/:subject/remove', ...write((req, res) => {
        const profile = creatorOf(req, (req.body || {}).creator);
        allow(req, CAP.profileUpdate, profile.creator_subject);
        res.json(moderation.removeModerator(profile.creator_subject, req.params.subject));
    }));

    // ── Simulation ───────────────────────────────────────────
    r.post('/simulate', ...write((req, res) => {
        const b = req.body || {};
        const profile = creatorOf(req, b.creator);
        allow(req, CAP.simulate, profile.creator_subject);
        const by = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const i = interactions.simulate(profile, b, { by });
        res.status(201).json({ interaction: interactions.present(i, { viewer: 'owner' }) });
    }));

    return r;
}

/** Async-safe handler: TipsError → problem+json; anything else → 500. */
function wrap(fn) {
    return (req, res, next) => {
        try {
            const p = fn(req, res, next);
            if (p && typeof p.catch === 'function') p.catch((e) => sendError(req, res, e));
        } catch (e) { sendError(req, res, e); }
    };
}

function sendError(req, res, e) {
    if (res.headersSent) return;
    if (e instanceof TipsError) {
        return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message, ctx: req.ov, extra: e.extra && e.status < 500 ? { details: e.extra } : undefined });
    }
    console.error('[Tips] unexpected error:', e);
    return http.sendProblem(res, 500, 'tips.internal', { detail: 'internal error', ctx: req.ov });
}

module.exports = { v1Router, wrap, sendError, CAP };
