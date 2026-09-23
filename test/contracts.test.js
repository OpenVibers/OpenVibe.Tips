'use strict';
// Every event Tips puts in its outbox is a valid events.event-envelope@1 whose payload validates
// against the tips.* payload schema released in openvibe-contracts (v0.30.2 registers all six).
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const TYPES = ['tips.interaction.ready', 'tips.interaction.failed', 'tips.interaction.cancelled', 'tips.goal.updated', 'tips.overlay.delivered', 'tips.overlay.failed'];

(async () => {
    const t = await boot({ live: true });
    const { domain, billing, live } = t;
    const alex = await t.creator('alex', { settings: { tts_enabled: true } });
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 10_000);

    await check('the six tips.* payload schemas are in the installed contracts', async () => {
        for (const type of TYPES) assert.strictEqual(contracts.resolve(type).owner, 'tips', type);
    });

    await check('a flow that produces every tips.* event: each envelope and payload validates', async () => {
        await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 1000 } });
        const tok = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts', 'goals'] } });
        const s = await t.sse(`/overlay/${tok.json.secret}/events`);
        const tip = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 300, message: 'hi' } });
        await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === tip.json.interaction.id);
        s.close();
        await domain.effects.drain();
        // A delivery Live refuses (tips.interaction.failed), an overlay nobody showed (tips.overlay.failed).
        live.state.fail = 422;
        await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 5 } });
        await domain.effects.drain();
        live.state.fail = null;
        t.clock.offset += 11 * 60 * 1000;
        domain.overlays.sweepFailed();
        t.clock.offset = 0;
        // A reversal before delivery (tips.interaction.cancelled) and one after it.
        const pending = await t.call('POST', '/api/v1/tts-requests', { user: viewer, body: { creator: 'alex', amount: 150, tts: { text: 'read me' } } });
        const txn = domain.interactions.get(pending.json.interaction.id).billing_txn_id;
        await t.deliver(billing.refund(txn));
        await t.deliver(billing.refund(domain.interactions.get(tip.json.interaction.id).billing_txn_id, 100));

        const rows = t.outboxRows();
        for (const type of TYPES) assert.ok(rows.some((e) => e.event_type === type), `no ${type} was produced`);
        for (const e of rows) {
            const env = contracts.validate('events.event-envelope@1', e);
            assert.ok(env.valid, `${e.event_type} envelope: ${JSON.stringify(env.errors)}`);
            const p = contracts.validate(e.event_type, e.payload);
            assert.ok(p.valid, `${e.event_type} payload: ${JSON.stringify(p.errors)} in ${JSON.stringify(e.payload)}`);
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
