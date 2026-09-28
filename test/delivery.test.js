'use strict';
// The live-chat delivery adapter: Tips' service token for Live, one delivery id per effect, retries
// for outages, an immediate stop for refusals — and never a change to the payment.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ live: true });
    const { domain, billing, live } = t;
    await t.creator('alex', { settings: { tts_enabled: true } });
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 5000);

    await check('a settled tip is posted to Live with a service token (openvibe.live, live.tips_delivery.write)', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 120, message: 'gg', target: { service: 'live', type: 'stream', id: '42' } } });
        await domain.effects.drain();
        const d = live.deliveries.find((x) => x.job.interaction.id === r.json.interaction.id);
        assert.ok(d, 'delivered to Live');
        assert.strictEqual(d.key, `${r.json.interaction.id}:chat_line`);
        assert.strictEqual(d.job.effect, 'chat_line');
        assert.strictEqual(d.job.text, 'Viewer tipped 120 Vibes: gg');
        assert.deepStrictEqual(d.job.target, { service: 'live', type: 'stream', id: '42' });
        assert.strictEqual(d.job.creator.handle, 'alex');
        assert.strictEqual(d.job.test, false);
        const grant = t.network.grants.find((g) => g.audience === 'openvibe.live');
        assert.strictEqual(grant.scope, 'live.tips_delivery.write');
        const e = await t.db.maybe("SELECT * FROM interaction_effects WHERE interaction_id = $1 AND effect = 'chat_line'", [r.json.interaction.id]);
        assert.deepStrictEqual(e.result.ref, { chat_message_id: 1 }, 'jsonb comes back parsed');
    });

    await check('TTS goes out as its own effect with the text and voice', async () => {
        const r = await t.call('POST', '/api/v1/tts-requests', { user: viewer, body: { creator: 'alex', amount: 150, tts: { text: 'hello https://x.example there' } } });
        assert.strictEqual(r.status, 201, r.text);
        await domain.effects.drain();
        const d = live.deliveries.find((x) => x.job.interaction.id === r.json.interaction.id && x.job.effect === 'tts');
        assert.deepStrictEqual(d.job.tts, { text: 'hello link there', voice: 'gary' });
    });

    await check('Live down (503): retried with backoff; the payment stays settled throughout', async () => {
        live.state.fail = 503;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 7 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        let e = await t.db.maybe("SELECT * FROM interaction_effects WHERE interaction_id = $1 AND effect = 'chat_line'", [id]);
        assert.strictEqual(e.state, 'queued');
        assert.match(e.last_error, /Live 503/);
        assert.strictEqual((await domain.interactions.get(t.db, id)).payment_state, 'settled');
        live.state.fail = null;
        t.clock.offset += 5000;
        await domain.effects.drain();
        t.clock.offset = 0;
        e = await t.db.maybe("SELECT * FROM interaction_effects WHERE interaction_id = $1 AND effect = 'chat_line'", [id]);
        assert.strictEqual(e.state, 'delivered');
        assert.strictEqual((await domain.interactions.get(t.db, id)).delivery_state, 'delivered');
    });

    await check('Live refuses (422): the effect fails at once, tips.interaction.failed, payment untouched', async () => {
        live.state.fail = 422;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 8 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        live.state.fail = null;
        const i = await domain.interactions.get(t.db, id);
        assert.strictEqual(i.delivery_state, 'failed');
        assert.strictEqual(i.payment_state, 'settled');
        assert.strictEqual(billing.payable.get((await t.domain.profiles.byHandle(t.db, 'alex')).creator_subject) >= 8, true);
        assert.strictEqual((await t.outboxRows('tips.interaction.failed')).filter((ev) => ev.subject.id === id).length, 1);
    });

    await check('simulations never reach Live: their chat effects stay in the test adapter', async () => {
        const alex = await t.domain.profiles.byHandle(t.db, 'alex');
        const before = live.deliveries.length;
        const sim = await domain.interactions.simulate(alex, { kind: 'tip', amount: 100 }, { by: alex.creator_subject });
        await domain.effects.drain();
        assert.strictEqual(live.deliveries.length, before);
        assert.ok(t.adapters.test.jobs.some((j) => j.interaction.id === sim.id && j.test));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
