'use strict';
// /api/v1: service tokens need the one capability each route checks; people act only on their own
// things; idempotency keys; goals derive from settled interactions only.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const { domain, billing } = t;
    const alex = await t.creator('alex');
    const bob = await t.creator('bob', { settings: { page_enabled: false } });
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 10_000);

    await check('health, ready and release.json', async () => {
        const h = await t.call('GET', '/api/health', { token: null });
        assert.strictEqual(h.json.service, 'tips');
        const r = await t.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.json.ready, true);
        const rel = await t.call('GET', '/release.json', { token: null });
        assert.strictEqual(rel.json.service, 'tips');
    });

    await check('a service token for another audience, or without the capability, is refused', async () => {
        const wrongAud = t.network.signService({ aud: ['openvibe.billing'], cap: ['tips.*'] });
        const a = await t.call('GET', '/api/v1/interactions?creator=alex', { token: wrongAud });
        assert.strictEqual(a.status, 401);
        const b = await t.call('GET', '/api/v1/interactions?creator=alex', { cap: ['tips.interaction.get'] });
        assert.strictEqual(b.status, 403);
        assert.strictEqual(b.headers.get('content-type'), 'application/problem+json');
        const c = await t.call('GET', '/api/v1/interactions?creator=alex', { cap: ['tips.interaction.list'] });
        assert.strictEqual(c.status, 200, c.text);
        const garbage = await t.call('GET', '/api/v1/interactions', { token: 'not.a.token' });
        assert.strictEqual(garbage.status, 401);
    });

    await check('profiles: public when the page is on; a switched-off page exists only for its creator and granted services', async () => {
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex', { token: null })).status, 200);
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/bob', { token: null })).status, 404);
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/bob', { user: viewer })).status, 404);
        const own = await t.call('GET', '/api/v1/profiles/bob', { user: bob });
        assert.strictEqual(own.status, 200);
        assert.strictEqual(own.json.profile.page_enabled, false);
        assert.ok(own.json.profile.revision >= 1);
        assert.strictEqual((await t.call('GET', `/api/v1/profiles/${bob.subject}`, { cap: ['tips.profile.get'] })).status, 200);
        const upd = await t.call('PATCH', '/api/v1/profiles/bob', { user: viewer, body: { accepting: false } });
        assert.strictEqual(upd.status, 403);
        const svc = await t.call('PATCH', `/api/v1/profiles/${bob.subject}`, { cap: ['tips.profile.update'], body: { headline: 'Streams at 8' } });
        assert.strictEqual(svc.status, 200, svc.text);
        assert.strictEqual(svc.json.profile.headline, 'Streams at 8');
        const stale = await t.call('PATCH', '/api/v1/profiles/me', { user: bob, body: { headline: 'x', revision: 1 } });
        assert.strictEqual(stale.status, 409);
    });

    await check('a service can open a profile for a creator subject (tips.profile.update)', async () => {
        const carol = t.network.newUser('carol');
        const r = await t.call('PATCH', `/api/v1/profiles/${carol.subject}`, { cap: ['tips.profile.update'], body: { handle: 'carol', display_name: 'Carol', page_enabled: true } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.profile.handle, 'carol');
        const reserved = t.network.newUser('dashboard');
        const r2 = await t.call('PATCH', '/api/v1/profiles/me', { user: reserved, body: {} });
        assert.notStrictEqual(r2.json.profile.handle, 'dashboard', 'reserved paths are never handles');
    });

    await check('a service tips on behalf of a supporter with tips.checkout.create; the capability is per kind', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { cap: ['tips.checkout.create'], body: { creator: 'alex', supporter: { type: 'user', id: viewer.subject }, supporter_name: 'Viewer', amount: 10 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.interaction.payment.state, 'settled');
        const pm = await t.call('POST', '/api/v1/paid-messages', { cap: ['tips.checkout.create'], body: { creator: 'alex', supporter: viewer.subject, amount: 200, message: 'hi' } });
        assert.strictEqual(pm.status, 403, 'paid messages need tips.superchat.create');
        const ok = await t.call('POST', '/api/v1/paid-messages', { cap: ['tips.superchat.create'], body: { creator: 'alex', supporter: viewer.subject, amount: 200, message: 'hi' } });
        assert.strictEqual(ok.status, 201, ok.text);
        const tts = await t.call('POST', '/api/v1/tts-requests', { cap: ['tips.tts.request'], body: { creator: 'alex', supporter: viewer.subject, amount: 200, tts: { text: 'x' } } });
        assert.strictEqual(tts.status, 409, 'TTS is off on this page');
        assert.strictEqual(tts.json.code, 'tips.tts_disabled');
    });

    await check('the creator\'s rules: minimums, message length, media hosts', async () => {
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { min_amount: 5, media_requests_enabled: true, media_request_min: 50 } });
        const small = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 4 } });
        assert.strictEqual(small.json.code, 'tips.amount_too_small');
        const long = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 10, message: 'x'.repeat(301) } });
        assert.strictEqual(long.json.code, 'tips.text_too_long');
        const host = await t.call('POST', '/api/v1/media-requests', { user: viewer, body: { creator: 'alex', amount: 60, media: { url: 'https://evil.example/video' } } });
        assert.strictEqual(host.json.code, 'tips.invalid_media');
        const plain = await t.call('POST', '/api/v1/media-requests', { user: viewer, body: { creator: 'alex', amount: 60, media: { url: 'http://youtu.be/x' } } });
        assert.strictEqual(plain.json.code, 'tips.invalid_media');
        const smallCheckout = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 50, pay_with: 'checkout' } });
        assert.strictEqual(smallCheckout.json.code, 'tips.amount_too_small');
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { min_amount: 1 } });
    });

    await check('idempotency: a replay returns the same interaction and moves nothing; another body with the key is refused', async () => {
        const body = { creator: 'alex', amount: 33 };
        const a = await t.call('POST', '/api/v1/checkout', { user: viewer, body, key: 'tip-key-000001' });
        const before = billing.transfers().length;
        const b = await t.call('POST', '/api/v1/checkout', { user: viewer, body, key: 'tip-key-000001' });
        assert.strictEqual(b.headers.get('idempotent-replayed'), 'true');
        assert.strictEqual(b.json.interaction.id, a.json.interaction.id);
        assert.strictEqual(billing.transfers().length, before);
        const c = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { ...body, amount: 34 }, key: 'tip-key-000001' });
        assert.strictEqual(c.status, 422);
        assert.strictEqual(c.json.code, 'idempotency.key_reused');
        const none = await t.call('POST', '/api/v1/checkout', { user: viewer, body, key: null });
        assert.strictEqual(none.status, 400);
    });

    await check('receipts: supporters see their own, creators theirs, nobody else', async () => {
        const mine = await t.call('GET', '/api/v1/interactions', { user: viewer });
        assert.ok(mine.json.interactions.length >= 2);
        assert.ok(mine.json.interactions.every((i) => i.supporter.id === viewer.subject));
        assert.ok(mine.json.interactions.every((i) => i.effects === undefined), 'supporters do not see delivery internals');
        const theirs = await t.call('GET', '/api/v1/interactions?as=creator', { user: alex });
        assert.ok(theirs.json.interactions.every((i) => i.creator.id === alex.subject));
        const id = mine.json.interactions[0].id;
        assert.strictEqual((await t.call('GET', `/api/v1/interactions/${id}`, { user: bob })).status, 404);
        assert.strictEqual((await t.call('GET', `/api/v1/interactions/${id}`, { token: null })).status, 401);
        assert.strictEqual((await t.call('GET', `/api/v1/interactions/${id}`, { user: alex })).json.interaction.effects.length >= 1, true);
        const page1 = await t.call('GET', '/api/v1/interactions?limit=1', { user: viewer });
        assert.ok(page1.json.next_cursor);
        const page2 = await t.call('GET', `/api/v1/interactions?limit=1&cursor=${page1.json.next_cursor}`, { user: viewer });
        assert.notStrictEqual(page2.json.interactions[0].id, page1.json.interactions[0].id);
    });

    await check('goals: CRUD by the owner only; contributions come from settled interactions only', async () => {
        const g = await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Lights', target_amount: 100 } });
        assert.strictEqual(g.status, 201, g.text);
        const id = g.json.goal.id;
        assert.strictEqual((await t.call('PATCH', `/api/v1/goals/${id}`, { user: viewer, body: { title: 'mine now' } })).status, 403);
        assert.strictEqual((await t.call('POST', '/api/v1/goals', { cap: ['tips.goal.update'], body: { creator: 'alex', title: 'x', target_amount: 5 } })).status, 403);
        // Pending (checkout not paid) and failed payments never count.
        const buyer = t.network.newUser('buyer');
        await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 150, pay_with: 'checkout', provider: 'stripe', goal_id: id } });
        const broke = t.network.newUser('broke');
        await t.call('POST', '/api/v1/checkout', { user: broke, body: { creator: 'alex', amount: 70, goal_id: id } });
        let goal = (await t.call('GET', `/api/v1/goals/${id}`, { token: null })).json.goal;
        assert.strictEqual(goal.current_amount, 0);
        await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 60, goal_id: id } });
        await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 50, goal_id: id } });
        goal = (await t.call('GET', `/api/v1/goals/${id}`, { user: alex })).json.goal;
        assert.strictEqual(goal.current_amount, 110);
        assert.strictEqual(goal.reached, true);
        assert.strictEqual(goal.contributions.length, 2);
        assert.strictEqual(goal.carried_over_amount, 0);
        const edit = await t.call('PATCH', `/api/v1/goals/${id}`, { user: alex, body: { target_amount: 500, revision: goal.revision } });
        assert.strictEqual(edit.status, 200, edit.text);
        assert.strictEqual(edit.json.goal.reached, false);
        const stale = await t.call('PATCH', `/api/v1/goals/${id}`, { user: alex, body: { target_amount: 600, revision: goal.revision } });
        assert.strictEqual(stale.status, 409);
        const closed = await t.call('POST', `/api/v1/goals/${id}/close`, { user: alex });
        assert.strictEqual(closed.json.goal.status, 'closed');
        const list = await t.call('GET', '/api/v1/goals?creator=alex&status=closed', { token: null });
        assert.ok(list.json.goals.some((x) => x.id === id));
        assert.strictEqual((await t.call('GET', '/api/v1/goals?creator=bob', { token: null })).status, 404, 'a switched-off page shows no goals');
    });

    await check('totals: derived from settled interactions, never from a stored balance', async () => {
        const r = await t.call('GET', '/api/v1/profiles/alex/totals', { user: alex });
        const sum = t.db.prepare("SELECT SUM(amount - reversed_bits) AS n FROM tip_interactions WHERE creator_subject = ? AND test = 0 AND settlement IN ('billing','imported') AND payment_state IN ('settled','reversed')").get(alex.subject).n;
        assert.strictEqual(r.json.totals.settled_via_billing, sum);
        assert.strictEqual(r.json.totals.settled_via_billing, billing.payable.get(alex.subject), 'equals what Billing holds for the creator');
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex/totals', { user: viewer })).status, 403);
    });

    await check('overlay configs are the owner\'s (tips.overlay.config.* for services)', async () => {
        const c = await t.call('POST', '/api/v1/overlay-configs', { user: alex, body: { kind: 'alerts', sound_url: 'http://insecure.example/a.mp3' } });
        assert.strictEqual(c.status, 422);
        const ok = await t.call('POST', '/api/v1/overlay-configs', { cap: ['tips.overlay.config.update'], body: { creator: 'alex', kind: 'goal', name: 'Goal bar' } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.strictEqual((await t.call('GET', '/api/v1/overlay-configs?creator=alex', { cap: ['tips.overlay.config.update'] })).status, 403);
        assert.strictEqual((await t.call('GET', '/api/v1/overlay-configs?creator=alex', { cap: ['tips.overlay.config.get'] })).status, 200);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
