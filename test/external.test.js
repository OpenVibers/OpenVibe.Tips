'use strict';
// EXTERNAL PowerChat tips announced by Billing (billing.receipt.external): once the PowerChat webhook
// points at Billing, Live no longer celebrates a tip on a streamer's own PowerChat, so Tips does —
// the chat line through Live's /internal/tips/deliveries (as Live's webhook wrote it), the overlay
// alert and the goal — exactly once per provider payment, and never counted as Billing money.
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ live: true });
    const { domain, live } = t;
    const alex = await t.creator('alex');
    console.log('external receipts');

    /** billing.receipt.external as Billing's ops/external.js writes it. */
    const receipt = (fields = {}, { streamer = alex.subject } = {}) => {
        const paymentId = fields.provider_event_id || `don-${Math.random().toString(36).slice(2)}`;
        return {
            event_id: ids.newId('event'), event_type: 'billing.receipt.external', version: 1, source: 'billing', actor: { type: 'service', id: 'billing' },
            timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal', subject: { type: 'provider_receipt', id: `powerchat:${paymentId}` },
            payload: {
                classification: 'EXTERNAL', provider: 'powerchat', receipt_ref: `powerchat:${paymentId}`, provider_event_id: paymentId, delivery_id: `dlv-${paymentId}`,
                streamer: { type: 'user', id: streamer }, receiving_account: { provider: 'powerchat', id: 'pc-1', username: 'alexpc' },
                amount_cents: 500, currency: 'usd-cents', value_bits: 500, donor_name: 'Fan', anonymous: false, message: null,
                app_ref: null, app_purpose: null, occurred_at: new Date().toISOString(), test: false, rates: { bits_per_usd: 100 }, ...fields,
            },
        };
    };
    const byRef = (ref) => t.db.prepare("SELECT * FROM tip_interactions WHERE provider = 'powerchat' AND provider_ref = ?").get(ref);

    let first;
    await check('an EXTERNAL receipt is recorded, settled and announced in Live chat as Live\'s webhook wrote it', async () => {
        const g = await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'New camera', target_amount: 5000 } });
        assert.strictEqual(g.status, 201, g.text);
        first = receipt({ provider_event_id: 'ext-1', amount_cents: 1234, value_bits: 1234, donor_name: 'Generous Fan', message: 'love the stream' });
        const r = await t.deliver(first);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.outcome, 'recorded_external');
        const i = byRef('ext-1');
        assert.deepStrictEqual([i.creator_subject, i.kind, i.amount, i.amount_cents, i.supporter_name, i.message], [alex.subject, 'tip', 1234, 1234, 'Generous Fan', 'love the stream']);
        assert.deepStrictEqual([i.funding, i.settlement, i.origin, i.payment_state, i.billing_txn_id], ['external', 'external', 'billing-external', 'settled', null]);
        await domain.effects.drain();
        const d = live.deliveries.filter((x) => x.job.interaction.id === i.id);
        assert.strictEqual(d.length, 1);
        assert.deepStrictEqual([d[0].key, d[0].job.effect, d[0].job.test], [`${i.id}:chat_line`, 'chat_line', false]);
        assert.strictEqual(d[0].job.text, 'Generous Fan tipped 1,234 Vibes: love the stream (PowerChat)');
        assert.deepStrictEqual(d[0].job.creator, { type: 'user', id: alex.subject, handle: 'alex' });
        const effects = t.db.prepare('SELECT effect, state FROM interaction_effects WHERE interaction_id = ? ORDER BY id').all(i.id);
        assert.deepStrictEqual(effects, [{ effect: 'overlay_alert', state: 'delivered' }, { effect: 'chat_line', state: 'delivered' }]);
        const goal = domain.goals.present(domain.goals.get(g.json.goal.id));
        assert.strictEqual(goal.current_amount, 1234, 'the sole active goal advances, as on Live');
        assert.ok(t.outboxRows('tips.goal.updated').some((e) => e.payload.interaction_id === i.id));
        assert.ok(t.outboxRows('tips.interaction.ready').some((e) => e.subject.id === i.id));
    });

    await check('a redelivery or a republish of the same payment announces nothing more', async () => {
        assert.strictEqual((await t.deliver(first)).json.duplicate, true);
        const again = await t.deliver({ ...first, event_id: ids.newId('event') });
        assert.deepStrictEqual([again.json.duplicate, again.json.outcome], [false, 'duplicate_receipt']);
        const viaApi = await t.call('POST', '/api/v1/interactions/external', { cap: ['tips.interaction.record'], body: { creator: 'alex', provider: 'powerchat', provider_ref: 'ext-1', amount_cents: 1234 } });
        assert.strictEqual(viaApi.json.duplicate, true, 'the same key as POST /interactions/external');
        await domain.effects.drain();
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM tip_interactions WHERE provider_ref = 'ext-1'").get().n, 1);
        assert.strictEqual(live.deliveries.filter((x) => x.job.interaction.id === byRef('ext-1').id).length, 1);
    });

    await check('EXTERNAL money stays out of the Billing total', async () => {
        const totals = domain.interactions.totals(alex.subject);
        assert.strictEqual(totals.external, 1234);
        assert.strictEqual(totals.settled_via_billing, 0);
    });

    await check('the goal the tip asked for: a Tips goal id, or a Live goal id through the import map', async () => {
        const a = (await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 900 } })).json.goal;
        const b = (await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Chair', target_amount: 900 } })).json.goal;
        await t.deliver(receipt({ provider_event_id: 'ext-goal-tips', amount_cents: 100, value_bits: 100, app_purpose: `goal:${a.id}` }));
        t.db.prepare(`INSERT INTO migration_maps (source, source_table, source_id, target_type, target_id, status, run_id, created_at, updated_at)
            VALUES ('live', 'donation_goals', '12', 'goal', ?, 'imported', 'imp_test', ?, ?)`).run(b.id, new Date().toISOString(), new Date().toISOString());
        await t.deliver(receipt({ provider_event_id: 'ext-goal-live', amount_cents: 200, value_bits: 200, app_purpose: 'goal:12' }));
        await t.deliver(receipt({ provider_event_id: 'ext-goal-none', amount_cents: 300, value_bits: 300 }));
        assert.strictEqual(domain.goals.present(domain.goals.get(a.id)).current_amount, 100);
        assert.strictEqual(domain.goals.present(domain.goals.get(b.id)).current_amount, 200);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_goal_contributions WHERE interaction_id = ?').get(byRef('ext-goal-none').id).n, 0, 'several active goals and no pick: none (Live\'s rule)');
    });

    await check('anonymous: no donor name; a creator with no tip page is still announced', async () => {
        const bob = t.network.newUser('bob');
        await t.deliver(receipt({ provider_event_id: 'ext-anon', donor_name: null, anonymous: true, message: 'hi' }, { streamer: bob.subject }));
        const i = byRef('ext-anon');
        assert.deepStrictEqual([i.creator_subject, i.supporter_name], [bob.subject, 'Anonymous']);
        await domain.effects.drain();
        const d = live.deliveries.find((x) => x.job.interaction.id === i.id);
        assert.strictEqual(d.job.text, 'Anonymous tipped 500 Vibes: hi (PowerChat)');
        assert.strictEqual(d.job.creator.handle, null);
    });

    await check('a test receipt never reaches Live chat or a goal', async () => {
        const before = live.deliveries.length;
        await t.deliver(receipt({ provider_event_id: 'ext-test', test: true }));
        await domain.effects.drain();
        const i = byRef('ext-test');
        assert.strictEqual(i.test, 1);
        assert.strictEqual(live.deliveries.length, before);
        assert.strictEqual(t.adapters.test.jobs.filter((j) => j.interaction.id === i.id).length, 1);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_goal_contributions WHERE interaction_id = ?').get(i.id).n, 0);
    });

    await check('malformed or foreign receipts are ignored, not recorded', async () => {
        const n = t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n;
        assert.strictEqual((await t.deliver(receipt({ streamer: { type: 'user', id: '42' } }))).json.outcome, 'ignored:no_streamer');
        assert.strictEqual((await t.deliver(receipt({ amount_cents: 1e20 }))).json.outcome, 'ignored:no_amount');
        assert.strictEqual((await t.deliver(receipt({ provider_event_id: '' }))).json.outcome, 'ignored:no_reference');
        assert.strictEqual((await t.deliver({ ...receipt(), source: 'live' })).json.outcome, 'ignored:source');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n, n);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
