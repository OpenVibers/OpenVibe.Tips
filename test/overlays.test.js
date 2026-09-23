'use strict';
// Overlays: scoped revocable tokens, SSE delivery, replay that never charges or re-counts, the
// delivery window, and simulations that are never counted.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const { domain, billing } = t;
    const alex = await t.creator('alex');
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 10_000);
    const goal = (await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 1000 } })).json.goal;

    let secret;
    let tokenId;
    await check('an overlay token is shown once, stored hashed, and scoped', async () => {
        const r = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { label: 'OBS', scopes: ['alerts', 'goals'] } });
        assert.strictEqual(r.status, 201, r.text);
        secret = r.json.secret;
        tokenId = r.json.token.id;
        assert.match(secret, /^tovl_[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(r.json.overlay_url, `http://tips.test/overlay/${secret}`);
        const row = t.db.prepare('SELECT * FROM overlay_tokens WHERE id = ?').get(tokenId);
        assert.notStrictEqual(row.token_hash, secret);
        assert.ok(!JSON.stringify(row).includes(secret), 'the secret is not stored');
        const list = await t.call('GET', '/api/v1/overlay-tokens', { user: alex });
        assert.ok(!list.text.includes(secret), 'listing never shows the secret');
        const other = t.network.newUser('mallory');
        const denied = await t.call('POST', '/api/v1/overlay-tokens', { user: other, body: { creator: 'alex' } });
        assert.strictEqual(denied.status, 403);
        const bad = await t.sse('/overlay/tovl_not-a-real-token-at-all-000000000000000000/events');
        assert.strictEqual(bad.statusCode, 404);
    });

    let firstAlertSeq;
    await check('a settled tip reaches a connected overlay once (tips.overlay.delivered once)', async () => {
        const s = await t.sse(`/overlay/${secret}/events`);
        assert.strictEqual(s.statusCode, 200);
        const hello = await s.waitFor((e) => e.event === 'hello');
        assert.strictEqual(hello.data.goals[0].id, goal.id);
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 300, message: 'hi' } });
        const alert = await s.waitFor((e) => e.event === 'alert');
        assert.strictEqual(alert.data.interaction_id, r.json.interaction.id);
        assert.strictEqual(alert.data.amount, 300);
        assert.strictEqual(alert.data.test, false);
        const g = await s.waitFor((e) => e.event === 'goal' && e.data.goal.current_amount === 300);
        assert.strictEqual(g.data.goal.id, goal.id);
        firstAlertSeq = alert.id;
        s.close();
        const d = t.db.prepare("SELECT * FROM overlay_deliveries WHERE kind = 'alert' AND interaction_id = ?").get(r.json.interaction.id);
        assert.strictEqual(d.status, 'delivered');
        assert.strictEqual(t.outboxRows('tips.overlay.delivered').filter((e) => e.payload.delivery_id === d.id).length, 1);
    });

    await check('overlay replay (Last-Event-ID) resends but never charges, re-counts or re-emits', async () => {
        const before = {
            transfers: billing.transfers().length, contributions: t.db.prepare('SELECT COUNT(*) AS n FROM tip_goal_contributions').get().n,
            goal: domain.goals.present(domain.goals.get(goal.id)).current_amount, delivered: t.outboxRows('tips.overlay.delivered').length,
            interactions: t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n, payable: billing.payable.get(alex.subject),
        };
        for (let k = 0; k < 3; k++) {
            const s = await t.sse(`/overlay/${secret}/events`, { lastEventId: firstAlertSeq - 1 });
            const again = await s.waitFor((e) => e.event === 'alert');
            assert.strictEqual(again.id, firstAlertSeq);
            s.close();
        }
        assert.strictEqual(billing.transfers().length, before.transfers);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_goal_contributions').get().n, before.contributions);
        assert.strictEqual(domain.goals.present(domain.goals.get(goal.id)).current_amount, before.goal);
        assert.strictEqual(t.outboxRows('tips.overlay.delivered').length, before.delivered);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n, before.interactions);
        assert.strictEqual(billing.payable.get(alex.subject), before.payable);
        assert.ok(t.db.prepare('SELECT sends FROM overlay_deliveries WHERE seq = ?').get(firstAlertSeq).sends >= 4);
    });

    await check('a tip while no overlay is connected waits, is delivered on connect, else fails after the window', async () => {
        const r1 = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 11 } });
        const s = await t.sse(`/overlay/${secret}/events`);
        const late = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === r1.json.interaction.id);
        assert.ok(late);
        s.close();
        await new Promise((ok) => setTimeout(ok, 50));
        const r2 = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 12 } });
        t.clock.offset += 11 * 60 * 1000;
        const n = domain.overlays.sweepFailed();
        t.clock.offset = 0;
        assert.ok(n >= 1);
        const d = t.db.prepare("SELECT * FROM overlay_deliveries WHERE kind = 'alert' AND interaction_id = ?").get(r2.json.interaction.id);
        assert.strictEqual(d.status, 'failed');
        assert.strictEqual(t.outboxRows('tips.overlay.failed').filter((e) => e.payload.delivery_id === d.id).length, 1);
        // The payment is untouched by the overlay failure.
        assert.strictEqual(domain.interactions.get(r2.json.interaction.id).payment_state, 'settled');
    });

    await check('simulation runs the full path with test = 1, no Billing call, never counted', async () => {
        const before = {
            transfers: billing.calls.length, goal: domain.goals.present(domain.goals.get(goal.id)).current_amount,
            totals: domain.interactions.totals(alex.subject), events: t.outboxRows().length,
        };
        const s = await t.sse(`/overlay/${secret}/events`);
        await s.waitFor((e) => e.event === 'hello');
        const r = await t.call('POST', '/api/v1/simulate', { user: alex, body: { kind: 'paid_message', amount: 500, message: 'test run', supporter_name: 'Tester' } });
        assert.strictEqual(r.status, 201, r.text);
        const i = r.json.interaction;
        assert.strictEqual(i.test, true);
        assert.strictEqual(i.settlement, 'simulated');
        const alert = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === i.id);
        assert.strictEqual(alert.data.test, true);
        const g = await s.waitFor((e) => e.event === 'goal' && e.data.test === true);
        assert.strictEqual(g.data.goal.current_amount, before.goal + 500, 'the widget shows the would-be total');
        s.close();
        await domain.effects.drain();
        const job = t.adapters.test.jobs.find((j) => j.interaction.id === i.id);
        assert.ok(job && job.test === true, 'chat effect delivered to the test adapter, flagged test');
        assert.strictEqual(billing.calls.length, before.transfers, 'no Billing call');
        assert.strictEqual(domain.goals.present(domain.goals.get(goal.id)).current_amount, before.goal, 'goal unchanged');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_goal_contributions WHERE interaction_id = ?').get(i.id).n, 0);
        const after = domain.interactions.totals(alex.subject);
        assert.strictEqual(after.settled_via_billing, before.totals.settled_via_billing);
        assert.strictEqual(after.interactions, before.totals.interactions);
        assert.strictEqual(after.simulations, before.totals.simulations + 1);
        assert.strictEqual(t.outboxRows().length, before.events, 'no durable events for a simulation');
        const denied = await t.call('POST', '/api/v1/simulate', { user: viewer, body: { creator: 'alex' } });
        assert.strictEqual(denied.status, 403);
    });

    await check('a config change reaches open overlays; minimum alert amount filters small tips', async () => {
        const cfg = (await t.call('POST', '/api/v1/overlay-configs', { user: alex, body: { kind: 'alerts', name: 'Big only', min_amount: 1000 } })).json.config;
        const tok = (await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts'], config_id: cfg.id } })).json;
        const s = await t.sse(`/overlay/${tok.secret}/events`);
        const hello = await s.waitFor((e) => e.event === 'hello');
        assert.strictEqual(hello.data.config.settings.min_amount, 1000);
        assert.deepStrictEqual(hello.data.goals, [], 'no goals scope, no goals');
        await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 5 } });
        const big = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 1500 } });
        const a = await s.waitFor((e) => e.event === 'alert');
        assert.strictEqual(a.data.interaction_id, big.json.interaction.id, 'the small tip was filtered');
        assert.ok(!s.events.some((e) => e.event === 'goal'));
        await t.call('PATCH', `/api/v1/overlay-configs/${cfg.id}`, { user: alex, body: { duration_ms: 3000 } });
        const c = await s.waitFor((e) => e.event === 'config');
        assert.strictEqual(c.data.config.settings.duration_ms, 3000);
        s.close();
    });

    await check('revocation is immediate: the open stream is closed and the link stops working', async () => {
        const s = await t.sse(`/overlay/${secret}/events`);
        await s.waitFor((e) => e.event === 'hello');
        const r = await t.call('POST', `/api/v1/overlay-tokens/${tokenId}/revoke`, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.token.active, false);
        const rev = await s.waitFor((e) => e.event === 'revoked');
        assert.ok(rev);
        await new Promise((ok) => setTimeout(ok, 50));
        assert.strictEqual(s.ended, true, 'stream closed by the server');
        const again = await t.sse(`/overlay/${secret}/events`);
        assert.strictEqual(again.statusCode, 404);
        const page = await fetch(`${t.base}/overlay/${secret}`);
        assert.strictEqual(page.status, 404);
        const state = await fetch(`${t.base}/overlay/${secret}/state`);
        assert.strictEqual(state.status, 404);
    });

    await check('the overlay page and state need only the token (no cookie) and are never indexed or cached', async () => {
        const tok = (await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['goals'] } })).json;
        const page = await fetch(`${t.base}/overlay/${tok.secret}`);
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers.get('cache-control'), 'no-store');
        assert.match(page.headers.get('x-robots-tag'), /noindex/);
        assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
        const state = await (await fetch(`${t.base}/overlay/${tok.secret}/state`)).json();
        assert.strictEqual(state.goals[0].id, goal.id);
        assert.strictEqual(state.alerts, undefined, 'goals-only token sees no alerts');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
