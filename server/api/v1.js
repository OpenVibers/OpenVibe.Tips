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
 * | POST /sound-requests                   | tips.sound.request           | the supporter                       |
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
 * | GET  /profiles/:creator/sounds         | tips.profile.get (page off)  | anyone when the page is on; owner   |
 * | GET  /me/export, POST /me/erase        | —                            | the supporter's own tips            |
 * | GET  /moderation?creator=&state=       | tips.interaction.moderate    | the creator and their moderators    |
 * | POST /interactions/:id/hide|restore    | tips.interaction.moderate    | the creator and their moderators    |
 * | GET  /moderation/log?creator=          | tips.interaction.moderate    | owner                               |
 * | GET  /profiles/:creator/posts           | tips.post.list               | anyone when the page is on; owner   |
 * | GET  /profiles/:creator/posts/:id       | tips.post.list               | anyone when the page is on; owner   |
 * | GET  /profiles/:creator/posts/:id/body  | —                            | a member of a tier that reads it    |
 * | POST /profiles/:creator/posts           | tips.post.create             | owner                               |
 * | POST /posts/:id/hide, POST …/:id/unhide | tips.post.moderate           | owner                               |
 * | GET|POST /moderators, POST …/:s/remove | tips.profile.update          | owner                               |
 *
 * Paid requests take `privacy: { anonymous, hide_amount, private_message }` (server/domain/privacy.js).
 * Goals and supporters are answered in their public shape (the creator's page settings) to anyone
 * but the creator and granted services.
 */
const express = require('express');
const svc = require('openvibe-sdk/service');
const { fail, userSubject, displayName, inputError } = require('../util');
const { idempotent } = require('./idempotency');

const CAP = {
    profileGet: 'tips.profile.get',
    profileUpdate: 'tips.profile.update',
    checkout: 'tips.checkout.create',
    superchat: 'tips.superchat.create',
    tts: 'tips.tts.request',
    media: 'tips.media_request.create',
    sound: 'tips.sound.request',
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
    moderate: 'tips.interaction.moderate',   // in openvibe-contracts since v0.32.0 (was docs/capabilities-proposal/)
    postList: 'tips.post.list',               // members-only posts (docs/capabilities-proposal/)
    postCreate: 'tips.post.create',
    postModerate: 'tips.post.moderate',
};

function v1Router({ domain, apiAuth, limits, subjectAssertion }) {
    const r = express.Router();
    const { db, profiles, goals, interactions, overlays } = domain;
    const idem = idempotent(db, domain.now, domain.log);

    // Per-actor limits (api/actor-limits.js), after the credential and before any work: every read takes
    // the defaults; each write below names its own, tighter numbers.
    r.use(limits.reads('tips.read'));
    const edit = limits('tips.settings.update', { minute: 30, hour: 300 });     // profile, goals, overlay configs
    const moderate = limits('tips.interaction.moderate', { minute: 60, hour: 600 });
    const staffing = limits('tips.moderators.update', { minute: 10, hour: 100 });

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
    async function creatorOf(req, value, { mustExist = true } = {}) {
        const v = value != null && value !== '' ? value : (req.principal.kind === 'user' ? req.principal.subject : null);
        if (!v) fail(422, 'tips.invalid_input', 'creator is required');
        const ref = typeof v === 'object' ? userSubject(v, 'creator') : String(v);
        const profile = ref === 'me' && req.principal.kind === 'user' ? await profiles.bySubject(db, req.principal.subject) : await profiles.resolve(db, ref);
        if (!profile && mustExist) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        return profile;
    }
    const write = (handler) => [idem, wrap(handler)];
    // The person a route names must be the person the assertion names (plan H1: ADR-003, the
    // 2026-11-06 amendment). Without the module (an old caller) nothing is checked.
    const assertion = subjectAssertion || { person: async () => null };

    // ── Profiles ─────────────────────────────────────────────
    r.get('/profiles/:creator', wrap(async (req, res) => {
        const p = await creatorOf(req, req.params.creator);
        const who = req.principal;
        const mine = who.kind === 'user' && who.subject === p.creator_subject;
        const svc = who.kind === 'service' && apiAuth.granted(who, CAP.profileGet);
        // A page that is switched off does not exist for anyone but its creator and granted services.
        if (!p.page_enabled && !mine && !svc) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        const owner = mine || svc;
        const active = await goals.list(db, p.creator_subject, { status: 'active' });
        res.json({ profile: profiles.present(p, { owner }), goals: owner ? await goals.presentMany(db, active) : await goals.publicGoals(db, active, p) });
    }));

    /** The creator's paid sounds (what a supporter may pick for POST /sound-requests), when they are switched on. */
    r.get('/profiles/:creator/sounds', wrap(async (req, res) => {
        const p = await creatorOf(req, req.params.creator);
        const who = req.principal;
        const owner = (who.kind === 'user' && who.subject === p.creator_subject) || (who.kind === 'service' && apiAuth.granted(who, CAP.profileGet));
        if (!p.page_enabled && !owner) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        const list = p.sounds_enabled || owner ? await domain.sounds.list(db, p.creator_subject) : [];
        res.json({ creator: { type: 'user', id: p.creator_subject }, enabled: !!p.sounds_enabled, minimum: Number(p.sound_min), sounds: list.map((x) => ({ ...x, url: `${domain.config.baseUrl}${x.url}` })) });
    }));

    /** The supporters page: top supporters and recent public messages, as the creator chose to show them. */
    r.get('/profiles/:creator/supporters', wrap(async (req, res) => {
        const p = await creatorOf(req, req.params.creator);
        const who = req.principal;
        const owner = (who.kind === 'user' && who.subject === p.creator_subject) || (who.kind === 'service' && apiAuth.granted(who, CAP.profileGet));
        if (!owner && (!p.page_enabled || !p.page.supporters_page)) fail(404, 'tips.supporters_not_public', 'this creator does not show their supporters');
        const page = p.page;
        res.json({
            creator: { type: 'user', id: p.creator_subject }, page,
            leaderboard: (await interactions.leaderboard(db, p)).map((row) => (page.supporters_amounts ? row : { ...row, total: null })),
            recent: page.supporters_messages ? (await interactions.recentPublic(db, p)).map((v) => (page.supporters_amounts ? v : { ...v, amount: null })) : null,
        });
    }));

    // ── The supporter's own data ─────────────────────────────
    const person = (req) => {
        if (req.principal.kind !== 'user') fail(req.principal.kind === 'anonymous' ? 401 : 403, req.principal.kind === 'anonymous' ? 'token.missing' : 'tips.people_only', 'only the person themselves (a Network user token) can do this');
        return req.principal.subject;
    };
    r.get('/me/export', wrap(async (req, res) => res.json(await interactions.exportFor(person(req)))));
    // A person erasing their own tips does it once; the network's account deletion arrives through
    // /internal/events, which is never limited.
    r.post('/me/erase', limits('tips.me.erase', { minute: 3, hour: 10 }), ...write(async (req, res) => res.json(await interactions.erase(person(req)))));

    r.patch('/profiles/:creator', edit, ...write(async (req, res) => {
        const b = req.body || {};
        let p;
        if (req.params.creator === 'me') {
            if (req.principal.kind !== 'user') fail(401, 'token.missing', '`me` needs a user token');
            p = await profiles.ensure(req.principal.subject, { username: req.principal.username, displayName: req.principal.name, avatarUrl: req.principal.avatar });
        } else if (req.principal.kind === 'service' && /^usr_/.test(req.params.creator) && !(await profiles.bySubject(db, req.params.creator))) {
            allow(req, CAP.profileUpdate);
            // A service opening a profile for a creator names the account projection it knows.
            if (!b.handle) fail(422, 'tips.invalid_input', 'handle is required to create a profile');
            p = await profiles.ensure(userSubject(req.params.creator, 'creator'), { username: b.handle, displayName: b.display_name || b.handle, avatarUrl: b.avatar_url });
        } else {
            p = await creatorOf(req, req.params.creator);
        }
        allow(req, CAP.profileUpdate, p.creator_subject);
        const out = await profiles.update(p.creator_subject, b, { expectedRevision: b.revision });
        res.json({ profile: profiles.present(out, { owner: true }) });
    }));

    r.get('/profiles/:creator/totals', wrap(async (req, res) => {
        const p = await creatorOf(req, req.params.creator);
        allow(req, CAP.interactionList, p.creator_subject);
        res.json({ creator: { type: 'user', id: p.creator_subject }, totals: await interactions.totals(db, p.creator_subject) });
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
                // The service pays for this person: the person's own assertion says they allowed it.
                await assertion.person(req, supporter);
            } else {
                supporter = p.subject;
                supporterName = displayName(b.supporter_name) || p.name || p.username;
            }
            const profile = await creatorOf(req, b.creator);
            const funding = b.pay_with || 'credit';
            const tp = req.ov && req.ov.traceparent;
            // The person's own subject assertion (plan H1): it travels on to Billing, which checks it
            // against the person the money is for. A service that vouches for the person brings its
            // own assertion; a person tipping for themselves has their token, so Tips mints one for
            // Billing (Tips is the service that carries it).
            let carried = String(req.headers['x-ov-subject-assertion'] || '').trim() || null;
            if (!carried && p.kind === 'user' && typeof assertion.mint === 'function') {
                const auth = String(req.headers.authorization || '');
                const userToken = /^Bearer\s+/i.test(auth) ? auth.slice(7).trim() : null;
                carried = await assertion.mint({ userToken, subject: supporter, audience: 'openvibe.billing', for: ['svc:tips'] });
            }
            const { interaction, replay } = await interactions.request(profile, { ...b, kind }, { supporter, supporterName, funding, idempotencyKey: req.idempotencyKey });
            let i = interaction;
            const viewer = p.kind === 'service' ? 'service' : 'supporter';
            if (!replay) {
                if (funding === 'credit') {
                    const out = await interactions.transfer(i, { traceparent: tp, assertion: carried });
                    i = await interactions.get(db, i.id);
                    if (out.refused) {
                        fail(out.refused === 'billing.insufficient_funds' ? 409 : 422, out.refused, out.detail || 'Billing refused the tip', { interaction: await interactions.present(db, i, { viewer: 'supporter' }) });
                    }
                } else {
                    i = (await interactions.startCheckout(i, { provider: b.provider, traceparent: tp, assertion: carried })).interaction;
                }
            } else if (i.payment_state === 'failed') {
                fail(409, 'tips.payment_failed', i.failure || 'the payment for this request failed', { interaction: await interactions.present(db, i, { viewer: 'supporter' }) });
            }
            res.status(replay ? 200 : 201).json({
                interaction: await interactions.present(db, i, { viewer }),
                checkout_url: i.checkout_url || null, checkout_ref: i.checkout_ref || null,
            });
        });
    }
    // Every paid request starts a Billing transfer or checkout and may reach the creator's chat: one
    // budget for all four, refusals and retries included. A person sends at most 20 a minute and 200 an
    // hour; a service relaying its supporters' tips gets one a second (60 and 1200).
    const personPays = limits('tips.payment', { minute: 20, hour: 200 });
    const servicePays = limits('tips.payment', { minute: 60, hour: 1200 });
    const pays = (req, res, next) => (req.principal.kind === 'service' ? servicePays : personPays)(req, res, next);
    r.post('/checkout', pays, ...paid('tip', CAP.checkout));
    r.post('/paid-messages', pays, ...paid('paid_message', CAP.superchat));
    r.post('/tts-requests', pays, ...paid('tts', CAP.tts));
    r.post('/media-requests', pays, ...paid('media_request', CAP.media));
    r.post('/sound-requests', pays, ...paid('sound', CAP.sound));

    // ── Interactions ─────────────────────────────────────────
    // The hottest list: a keyset page of any size costs three queries (the page, the creators' filters,
    // the effects) — test/query-budget.test.js holds it there.
    r.get('/interactions', wrap(async (req, res) => {
        const p = req.principal;
        const q = req.query;
        let filter;
        if (p.kind === 'service') {
            allow(req, CAP.interactionList);
            filter = {
                creator: q.creator ? (await creatorOf(req, q.creator)).creator_subject : null,
                supporter: q.supporter ? userSubject(String(q.supporter), 'supporter') : null,
            };
            if (filter.supporter) await assertion.person(req, filter.supporter);
            if (!filter.creator && !filter.supporter) fail(422, 'tips.invalid_input', 'creator or supporter is required');
        } else if (p.kind === 'user') {
            filter = q.as === 'creator' ? { creator: p.subject } : { supporter: p.subject };
        } else fail(401, 'token.missing', 'sign in to see receipts');
        const out = await interactions.list(db, { ...filter, includeTest: q.include_test !== '0', cursor: q.cursor, limit: q.limit });
        const viewer = p.kind === 'service' ? 'service' : (filter.creator ? 'owner' : 'supporter');
        res.json({ interactions: await interactions.presentMany(db, out.rows, { viewer }), next_cursor: out.next_cursor });
    }));

    r.get('/interactions/:id', wrap(async (req, res) => {
        const i = await interactions.get(db, req.params.id);
        const p = req.principal;
        if (!i) fail(404, 'tips.interaction_not_found', 'no such interaction');
        let viewer;
        if (p.kind === 'service') { allow(req, CAP.interactionGet); viewer = 'service'; }
        else if (p.kind === 'user' && p.subject === i.creator_subject) viewer = 'owner';
        else if (p.kind === 'user' && p.subject === i.supporter_subject) viewer = 'supporter';
        else if (p.kind === 'anonymous') fail(401, 'token.missing', 'sign in to see this receipt');
        else fail(404, 'tips.interaction_not_found', 'no such interaction');
        res.json({ interaction: await interactions.present(db, i, { viewer }) });
    }));

    // A service importing tips made elsewhere records one per tip, at most one a second.
    r.post('/interactions/external', limits('tips.interaction.record', { minute: 60, hour: 1200 }), ...write(async (req, res) => {
        allow(req, CAP.interactionRecord);
        const b = req.body || {};
        const profile = await creatorOf(req, b.creator);
        const out = await interactions.recordExternal(profile, b);
        res.status(out.replay ? 200 : 201).json({ interaction: await interactions.present(db, out.interaction, { viewer: 'service' }), duplicate: out.replay });
    }));

    // ── Goals ────────────────────────────────────────────────
    const isOwner = (req, creator) => (req.principal.kind === 'user' && req.principal.subject === creator) || (req.principal.kind === 'service' && apiAuth.granted(req.principal, CAP.goalUpdate));
    r.get('/goals', wrap(async (req, res) => {
        const profile = await creatorOf(req, req.query.creator);
        const full = isOwner(req, profile.creator_subject);
        if (!profile.page_enabled && !full) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        const status = ['active', 'closed'].includes(req.query.status) ? req.query.status : undefined;
        const list = await goals.list(db, profile.creator_subject, { status });
        res.json({ goals: full ? await goals.presentMany(db, list) : await goals.publicGoals(db, list, profile) });
    }));
    r.get('/goals/:id', wrap(async (req, res) => {
        const g = await goals.get(db, req.params.id);
        const profile = g && await profiles.bySubject(db, g.creator_subject);
        const full = g && isOwner(req, g.creator_subject);
        if (!g || (!(profile && profile.page_enabled) && !full)) fail(404, 'tips.goal_not_found', 'no such goal');
        if (!full) return res.json({ goal: await goals.publicGoal(db, g, profile) });
        res.json({ goal: await goals.present(db, g, { contributions: true }) });
    }));
    r.post('/goals', edit, ...write(async (req, res) => {
        const b = req.body || {};
        const profile = await creatorOf(req, b.creator);
        allow(req, CAP.goalCreate, profile.creator_subject);
        res.status(201).json({ goal: await goals.create(profile.creator_subject, b) });
    }));
    const ownGoal = async (req, cap) => {
        const g = await goals.get(db, req.params.id);
        if (!g) fail(404, 'tips.goal_not_found', 'no such goal');
        allow(req, cap, g.creator_subject);
        return g;
    };
    r.patch('/goals/:id', edit, ...write(async (req, res) => res.json({ goal: await goals.update(await ownGoal(req, CAP.goalUpdate), req.body || {}) })));

    // ── Members-only posts ───────────────────────────────────────────────
    // The title and the tiers are public; the text is served only to a member of a tier that reads it
    // (the entitlement check, server/domain/posts.js). A hidden post is not served at all.
    const postsView = async (req, creator, { owner = false } = {}) => {
        const info = await domain.vip.creator(creator.creator_subject);
        const posts = await domain.posts.view({
            creatorSubject: creator.creator_subject,
            memberSubject: req.principal.kind === 'user' ? req.principal.subject : null,
            plans: info ? info.plans : [],
            owner,
        });
        for (const post of posts) post.join_url = post.unlocked ? null : await domain.vip.joinUrl(creator.creator_subject, post.tiers);
        return posts;
    };
    /** One post and whether this reader may read it (a hidden one is not served at all). */
    const onePost = async (req, creator, id) => {
        const post = await domain.posts.byId(id);
        if (!post || post.creator_subject !== creator.creator_subject || post.status !== 'published') fail(404, 'tips.post_not_found', 'no post ' + id);
        const info = await domain.vip.creator(creator.creator_subject);
        const owner = req.principal.kind === 'user' && req.principal.subject === creator.creator_subject;
        const access = owner ? { unlocked: true, tier: null } : await domain.posts.access({
            post, memberSubject: req.principal.kind === 'user' ? req.principal.subject : null,
            creatorSubject: creator.creator_subject, plans: info ? info.plans : [],
        });
        return { post, access };
    };
    /** The creator's posts: the title and the tiers for everyone, the text only for a member. */
    r.get('/profiles/:creator/posts', wrap(async (req, res) => {
        const creator = await creatorOf(req, req.params.creator);
        const who = req.principal;
        const owner = (who.kind === 'user' && who.subject === creator.creator_subject) || (who.kind === 'service' && apiAuth.granted(who, CAP.postList));
        if (!creator.page_enabled && !owner) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        res.json({ creator: { type: 'user', id: creator.creator_subject }, posts: await postsView(req, creator, { owner }) });
    }));
    r.get('/profiles/:creator/posts/:id', wrap(async (req, res) => {
        const creator = await creatorOf(req, req.params.creator);
        const who = req.principal;
        const owner = (who.kind === 'user' && who.subject === creator.creator_subject) || (who.kind === 'service' && apiAuth.granted(who, CAP.postList));
        if (!creator.page_enabled && !owner) fail(404, 'tips.creator_not_found', 'no tip profile for this creator');
        const { post, access } = await onePost(req, creator, req.params.id);
        res.json({ post: domain.posts.present(post, { unlocked: !!access.unlocked, tier: access.tier || null }) });
    }));
    /** The text itself: only for a member of a tier that reads it. */
    r.get('/profiles/:creator/posts/:id/body', wrap(async (req, res) => {
        const creator = await creatorOf(req, req.params.creator);
        const { post, access } = await onePost(req, creator, req.params.id);
        if (!access.unlocked) fail(403, 'tips.member_only', 'this post is for the members of a tier');
        res.json({ post: { id: post.id, title: post.title, body: post.body, body_html: post.body_html, tiers: domain.posts.tiersOf(post) } });
    }));
    r.post('/profiles/:creator/posts', edit, ...write(async (req, res) => {
        const b = req.body || {};
        const creator = await creatorOf(req, b.creator || req.params.creator);
        allow(req, CAP.postCreate, creator.creator_subject);
        const actor = req.principal.kind === 'user' ? req.principal.subject : req.principal.sub;
        const post = await domain.posts.create({ creatorSubject: creator.creator_subject, title: b.title, body: b.body, tiers: b.tiers, actor });
        res.status(201).json({ post: domain.posts.present(post, { unlocked: true }) });
    }));
    const ownPost = async (req, cap) => {
        const post = await domain.posts.byId(req.params.id);
        if (!post) fail(404, 'tips.post_not_found', 'no such post');
        allow(req, cap, post.creator_subject);
        return post;
    };
    r.post('/posts/:id/hide', edit, ...write(async (req, res) => {
        const post = await ownPost(req, CAP.postModerate);
        const actor = req.principal.kind === 'user' ? req.principal.subject : req.principal.sub;
        res.json({ post: domain.posts.present(await domain.posts.hide(post.id, { actor })) });
    }));
    r.post('/posts/:id/unhide', edit, ...write(async (req, res) => {
        const post = await ownPost(req, CAP.postModerate);
        const actor = req.principal.kind === 'user' ? req.principal.subject : req.principal.sub;
        res.json({ post: domain.posts.present(await domain.posts.unhide(post.id, { actor })) });
    }));
    r.post('/goals/:id/close', edit, ...write(async (req, res) => res.json({ goal: await goals.close(await ownGoal(req, CAP.goalClose)) })));

    // ── Overlay tokens and configs ───────────────────────────
    r.get('/overlay-tokens', wrap(async (req, res) => {
        const profile = await creatorOf(req, req.query.creator);
        allow(req, CAP.tokenCreate, profile.creator_subject);
        res.json({ tokens: (await overlays.listTokens(db, profile.creator_subject)).map(overlays.presentToken) });
    }));
    // A token opens an overlay's event stream: a creator mints a few for their scenes.
    r.post('/overlay-tokens', limits('tips.overlay.token.create', { minute: 10, hour: 60 }), ...write(async (req, res) => {
        const b = req.body || {};
        const profile = await creatorOf(req, b.creator);
        allow(req, CAP.tokenCreate, profile.creator_subject);
        const by = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const out = await overlays.createToken(profile.creator_subject, { scopes: b.scopes, label: b.label, configId: b.config_id, createdBy: by });
        // Shown once: only its hash is stored, and the stored answer for an Idempotency-Key replay has no
        // secret either (a caller who lost the answer revokes the token and creates another).
        res.locals.storedBody = { token: out.token, secret: null, overlay_url: null, events_url: null, note: 'the secret is shown once; revoke this token and create another' };
        res.status(201).json({ token: out.token, secret: out.secret, overlay_url: out.overlay_url, events_url: out.events_url });
    }));
    r.post('/overlay-tokens/:id/revoke', edit, ...write(async (req, res) => {
        const t = await overlays.getToken(db, req.params.id);
        if (!t) fail(404, 'tips.overlay_token_not_found', 'no such overlay token');
        allow(req, CAP.tokenRevoke, t.creator_subject);
        res.json({ token: await overlays.revokeToken(t) });
    }));

    r.get('/overlay-configs', wrap(async (req, res) => {
        const profile = await creatorOf(req, req.query.creator);
        allow(req, CAP.configGet, profile.creator_subject);
        res.json({ configs: (await overlays.listConfigs(db, profile.creator_subject)).map(overlays.presentConfig) });
    }));
    r.get('/overlay-configs/:id', wrap(async (req, res) => {
        const c = await overlays.getConfig(db, req.params.id);
        if (!c) fail(404, 'tips.overlay_config_not_found', 'no such overlay config');
        allow(req, CAP.configGet, c.creator_subject);
        res.json({ config: overlays.presentConfig(c) });
    }));
    r.post('/overlay-configs', edit, ...write(async (req, res) => {
        const b = req.body || {};
        const profile = await creatorOf(req, b.creator);
        allow(req, CAP.configUpdate, profile.creator_subject);
        res.status(201).json({ config: await overlays.createConfig(profile.creator_subject, b) });
    }));
    r.patch('/overlay-configs/:id', edit, ...write(async (req, res) => {
        const c = await overlays.getConfig(db, req.params.id);
        if (!c) fail(404, 'tips.overlay_config_not_found', 'no such overlay config');
        allow(req, CAP.configUpdate, c.creator_subject);
        res.json({ config: await overlays.updateConfig(c, req.body || {}) });
    }));

    // ── Moderation (server/domain/moderation.js) ─────────────
    const { moderation } = domain;
    /** The creator, one of their moderators, or a service with tips.interaction.moderate. */
    async function moderatorOf(req, creator, { hideExistence = false } = {}) {
        const p = req.principal;
        if (p.kind === 'anonymous') fail(401, 'token.missing', 'sign in (a Network user token) or present a service token');
        const a = await moderation.actorFor(db, p, creator, p.kind === 'service' && apiAuth.granted(p, CAP.moderate));
        if (a) return a;
        if (p.kind === 'service') fail(403, 'capability.denied', `${CAP.moderate} not granted`);
        if (hideExistence) fail(404, 'tips.interaction_not_found', 'no such interaction');
        fail(403, 'tips.forbidden', 'only the creator and their moderators moderate this page');
        return null;
    }
    r.get('/moderation', wrap(async (req, res) => {
        const profile = await creatorOf(req, req.query.creator);
        await moderatorOf(req, profile.creator_subject);
        const out = await moderation.queue(db, profile.creator_subject, { state: req.query.state || 'all', cursor: req.query.cursor, limit: req.query.limit });
        res.json({ creator: { type: 'user', id: profile.creator_subject }, interactions: out.rows, next_cursor: out.next_cursor });
    }));
    r.get('/moderation/log', wrap(async (req, res) => {
        const profile = await creatorOf(req, req.query.creator);
        allow(req, CAP.moderate, profile.creator_subject);
        res.json({ log: await moderation.log(db, profile.creator_subject) });
    }));
    for (const action of ['hide', 'restore']) {
        r.post(`/interactions/:id/${action}`, moderate, ...write(async (req, res) => {
            const i = await interactions.get(db, req.params.id);
            if (!i) fail(404, 'tips.interaction_not_found', 'no such interaction');
            const actor = await moderatorOf(req, i.creator_subject, { hideExistence: true });
            const out = await moderation[action](i, { ...actor, reason: (req.body || {}).reason });
            res.json({ interaction: await moderation.present(db, out.interaction), changed: out.changed, cancelled_effects: out.cancelled_effects || [] });
        }));
    }
    r.get('/moderators', wrap(async (req, res) => {
        const profile = await creatorOf(req, req.query.creator);
        allow(req, CAP.profileUpdate, profile.creator_subject);
        res.json({ moderators: (await moderation.listModerators(db, profile.creator_subject)).map(moderation.presentModerator) });
    }));
    r.post('/moderators', staffing, ...write(async (req, res) => {
        const b = req.body || {};
        const profile = await creatorOf(req, b.creator);
        allow(req, CAP.profileUpdate, profile.creator_subject);
        const by = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        res.status(201).json({ moderator: await moderation.addModerator(db, profile.creator_subject, b.moderator, { name: b.name, addedBy: by }) });
    }));
    r.post('/moderators/:subject/remove', staffing, ...write(async (req, res) => {
        const profile = await creatorOf(req, (req.body || {}).creator);
        allow(req, CAP.profileUpdate, profile.creator_subject);
        res.json(await moderation.removeModerator(profile.creator_subject, req.params.subject));
    }));

    // ── Simulation ───────────────────────────────────────────
    // A simulated tip plays on the creator's overlays and chat like a real one.
    r.post('/simulate', limits('tips.simulation.run', { minute: 10, hour: 100 }), ...write(async (req, res) => {
        const b = req.body || {};
        const profile = await creatorOf(req, b.creator);
        allow(req, CAP.simulate, profile.creator_subject);
        const by = req.principal.kind === 'service' ? req.principal.sub : req.principal.subject;
        const i = await interactions.simulate(profile, b, { by });
        res.status(201).json({ interaction: await interactions.present(db, i, { viewer: 'owner' }) });
    }));

    return r;
}

/**
 * Async-safe handler: TipsError → problem+json; anything else → 500 tips.internal with 'internal error'.
 * Built from openvibe-sdk/service (plan T1) with Tips' own options — the fallback code and detail, and
 * `extra` nested as { details } below 500, are the kit's internalCode / internalDetail / extra: 'details';
 * `map: inputError` keeps the database-refusal mapping (a value PostgreSQL cannot store → 422
 * tips.invalid_input). The exported signatures stay (fn) / (req, res, e), so no call site moves.
 */
const TIPS_ERRORS = { name: 'Tips', extra: 'details', internalCode: 'tips.internal', internalDetail: 'internal error', map: inputError };

const wrap = (fn) => svc.wrap(fn, TIPS_ERRORS);

const sendError = (req, res, e) => svc.sendError(res, req, e, undefined, TIPS_ERRORS);

module.exports = { v1Router, wrap, sendError, CAP };
