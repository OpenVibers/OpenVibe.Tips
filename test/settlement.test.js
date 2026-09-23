'use strict';
// Payment settles through Billing; delivery is separate. Duplicate Billing events and provider
// redeliveries yield one logical interaction; reversals flip payment state without erasing delivery.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const { domain, billing } = t;
    const alex = await t.creator('alex');
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 5000);

    let tipId;
    await check('a tip from credit settles through a Billing transfer (target = the interaction)', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 250, message: 'great stream' } });
        assert.strictEqual(r.status, 201, r.text);
        const i = r.json.interaction;
        tipId = i.id;
        assert.strictEqual(i.payment.state, 'settled');
        assert.strictEqual(i.delivery.state, 'queued');
        assert.match(i.payment.billing_txn_id, /^txn_/);
        const call = billing.transfers()[0];
        assert.strictEqual(call.key, `tips:transfer:${i.id}`);
        assert.deepStrictEqual(call.body.target, { service: 'tips', type: 'interaction', id: i.id });
        assert.strictEqual(call.body.kind, 'tip');
        assert.strictEqual(billing.payable.get(alex.subject), 250);
    });

    await check('the settled event for the same transaction is a no-op; a redelivery is an inbox duplicate', async () => {
        const ev = billing.events.find((e) => e.payload.metadata && e.payload.metadata.target && e.payload.metadata.target.id === tipId);
        const a = await t.deliver(ev);
        assert.strictEqual(a.status, 200);
        assert.strictEqual(a.json.duplicate, false);
        assert.strictEqual(a.json.outcome, 'duplicate_transaction');
        const b = await t.deliver(ev);
        assert.strictEqual(b.json.duplicate, true);
        // Same transaction republished under a new event id (a replay): still one interaction.
        const c = await t.deliver({ ...ev, event_id: billing.envelope('x', {}, 'x').event_id });
        assert.strictEqual(c.json.duplicate, false);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions WHERE billing_txn_id = ?').get(ev.payload.transaction_id).n, 1);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n, 1);
    });

    await check('a duplicate provider webhook (Billing settles once) → one logical interaction for a donation Tips did not start', async () => {
        // Billing turned one PowerChat site-routed tip into one transaction; Events may deliver it more than once.
        const ev = billing.foreignDonation({ from: null, to: alex.subject, amount: 300, provider: 'powerchat', message: 'from PowerChat' });
        for (let k = 0; k < 3; k++) await t.deliver(k === 2 ? { ...ev, event_id: billing.envelope('x', {}, 'x').event_id } : ev);
        const rows = t.db.prepare('SELECT * FROM tip_interactions WHERE billing_txn_id = ?').all(ev.payload.transaction_id);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].origin, 'billing');
        assert.strictEqual(rows[0].funding, 'provider');
        assert.strictEqual(rows[0].payment_state, 'settled');
        // Tips did not start it, so Tips does not announce it in chat a second time — overlay only.
        const effects = t.db.prepare('SELECT effect FROM interaction_effects WHERE interaction_id = ?').all(rows[0].id).map((e) => e.effect);
        assert.deepStrictEqual(effects, ['overlay_alert']);
        assert.strictEqual(rows[0].delivery_state, 'delivered');
    });

    await check('delivery runs after settlement; a delivery failure never touches payment state', async () => {
        const test = t.adapters.test;
        await domain.effects.drain();           // the first tip delivers normally
        assert.strictEqual(domain.interactions.get(tipId).delivery_state, 'delivered');
        test.state.failWith = 'chat is down';
        test.state.permanent = true;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: alex.subject, amount: 40 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        const i = domain.interactions.get(id);
        assert.strictEqual(i.payment_state, 'settled');
        assert.strictEqual(i.delivery_state, 'failed');
        assert.strictEqual(t.outboxRows('tips.interaction.failed').filter((e) => e.subject.id === id).length, 1);
        test.state.failWith = null;
        assert.strictEqual(test.jobs.find((j) => j.interaction.id === tipId).text, 'Viewer tipped 250 Vibes: great stream');
    });

    await check('a retryable delivery failure stays queued and is retried with backoff', async () => {
        const test = t.adapters.test;
        test.state.failWith = 'timeout'; test.state.permanent = false;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: alex.subject, amount: 10 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        const e = t.db.prepare("SELECT * FROM interaction_effects WHERE interaction_id = ? AND effect = 'chat_line'").get(id);
        assert.strictEqual(e.state, 'queued');
        assert.strictEqual(e.attempts, 1);
        test.state.failWith = null;
        t.clock.offset += 60_000;
        await domain.effects.drain();
        assert.strictEqual(domain.interactions.get(id).delivery_state, 'delivered');
        t.clock.offset = 0;
    });

    await check('reversal after delivery keeps the delivery record and flips payment state; goals drop by what Billing took back', async () => {
        const g = await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'New mic', target_amount: 1000 } });
        assert.strictEqual(g.status, 201, g.text);
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 400 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        assert.strictEqual(domain.interactions.get(id).delivery_state, 'delivered');
        assert.strictEqual(domain.goals.present(domain.goals.get(g.json.goal.id)).current_amount, 400);
        const rev = billing.refund(r.json.interaction.payment.billing_txn_id);
        const d = await t.deliver(rev);
        assert.strictEqual(d.json.outcome, 'reversed');
        const i = domain.interactions.get(id);
        assert.strictEqual(i.payment_state, 'reversed');
        assert.strictEqual(i.delivery_state, 'delivered');
        assert.strictEqual(i.reversed_bits, 400);
        assert.ok(t.db.prepare("SELECT COUNT(*) AS n FROM interaction_effects WHERE interaction_id = ? AND state = 'delivered'").get(id).n >= 2);
        assert.strictEqual(domain.goals.present(domain.goals.get(g.json.goal.id)).current_amount, 0);
        // The same reversal again changes nothing.
        const again = await t.deliver({ ...rev, event_id: billing.envelope('x', {}, 'x').event_id });
        assert.strictEqual(again.json.outcome, 'duplicate_reversal');
        assert.strictEqual(domain.interactions.get(id).reversed_bits, 400);
        await t.call('POST', `/api/v1/goals/${g.json.goal.id}/close`, { user: alex });
    });

    await check('reversal before delivery cancels the queued effects (tips.interaction.cancelled)', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 20 } });
        const id = r.json.interaction.id;
        await t.deliver(billing.refund(r.json.interaction.payment.billing_txn_id));
        const i = domain.interactions.get(id);
        assert.strictEqual(i.payment_state, 'reversed');
        assert.strictEqual(i.delivery_state, 'cancelled');
        await domain.effects.drain();
        assert.ok(!t.adapters.test.jobs.some((j) => j.interaction.id === id), 'nothing delivered after the reversal');
        assert.strictEqual(t.outboxRows('tips.interaction.cancelled').filter((e) => e.subject.id === id).length, 1);
    });

    await check('insufficient credit: payment failed, nothing delivered, a replay of the key answers the same', async () => {
        const poor = t.network.newUser('poor');
        const r = await t.call('POST', '/api/v1/checkout', { user: poor, body: { creator: 'alex', amount: 50 }, key: 'poor-key-00001' });
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(r.json.code, 'billing.insufficient_funds');
        assert.strictEqual(r.json.details.interaction.payment.state, 'failed');
        const again = await t.call('POST', '/api/v1/checkout', { user: poor, body: { creator: 'alex', amount: 50 }, key: 'poor-key-00001' });
        assert.strictEqual(again.status, 409);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions WHERE supporter_subject = ?').get(poor.subject).n, 1);
    });

    await check('self-tipping is refused by subject', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: alex, body: { creator: 'alex', amount: 50 } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json.code, 'tips.self_dealing');
    });

    await check('checkout: Billing intent → purchase settles → transfer → settled; goal counts only then', async () => {
        const g = await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Camera', target_amount: 500 } });
        const buyer = t.network.newUser('buyer');
        const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 300, pay_with: 'checkout', provider: 'stripe' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.json.checkout_url, /^https:\/\/checkout\.stripe\.test\/pi_/);
        const id = r.json.interaction.id;
        assert.strictEqual(r.json.interaction.payment.state, 'pending');
        assert.strictEqual(domain.goals.present(domain.goals.get(g.json.goal.id)).current_amount, 0, 'pending never counts');
        const intentId = domain.interactions.get(id).billing_intent_id;
        assert.strictEqual(billing.calls.find((c) => c.url === '/api/v1/intents' && c.body.subject.id === buyer.subject).key, `tips:intent:${id}`);
        const purchase = billing.settlePurchase(intentId);
        const d = await t.deliver(purchase);
        assert.strictEqual(d.json.outcome, 'funded');
        await new Promise((ok) => setTimeout(ok, 100));
        await domain.interactions.processDueTransfers();
        const i = domain.interactions.get(id);
        assert.strictEqual(i.payment_state, 'settled');
        assert.strictEqual(i.funding_txn_id, purchase.payload.transaction_id);
        assert.strictEqual(domain.goals.present(domain.goals.get(g.json.goal.id)).current_amount, 300);
        // The purchase event again, and the transfer's own event: nothing new.
        assert.strictEqual((await t.deliver(purchase)).json.duplicate, true);
        const own = billing.events.find((e) => e.payload.metadata && e.payload.metadata.target && e.payload.metadata.target.id === id);
        assert.strictEqual((await t.deliver(own)).json.outcome, 'duplicate_transaction');
        assert.strictEqual(billing.transfers().filter((c) => c.key === `tips:transfer:${id}`).length, 1);
    });

    await check('PowerChat checkout without a link template returns Billing\'s checkout_ref, no URL invented', async () => {
        const buyer = t.network.newUser('pcbuyer');
        const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 150, pay_with: 'checkout', provider: 'powerchat' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.checkout_url, null);
        assert.match(r.json.checkout_ref, /^pcorder:pi_/);
    });

    await check('Billing unreachable during a credit tip: pending, retried later with the same key, settles once', async () => {
        billing.state.down = true;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 15 } });
        assert.strictEqual(r.status, 201);
        const id = r.json.interaction.id;
        assert.strictEqual(r.json.interaction.payment.state, 'pending');
        billing.state.down = false;
        t.clock.offset += 5000;
        await domain.interactions.processDueTransfers();
        t.clock.offset = 0;
        assert.strictEqual(domain.interactions.get(id).payment_state, 'settled');
    });

    await check('paid messages, TTS and media requests exist only after settlement', async () => {
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { tts_enabled: true, media_requests_enabled: true } });
        const buyer = t.network.newUser('supporter2');
        const kinds = [
            ['/api/v1/paid-messages', { amount: 500, message: 'hello chat' }],
            ['/api/v1/tts-requests', { amount: 150, tts: { text: 'read me please', voice: 'amy' } }],
            ['/api/v1/media-requests', { amount: 150, media: { url: 'https://www.youtube.com/watch?v=abc' } }],
        ];
        const ids = [];
        for (const [p, body] of kinds) {
            const r = await t.call('POST', p, { user: buyer, body: { creator: 'alex', pay_with: 'checkout', provider: 'stripe', ...body } });
            assert.strictEqual(r.status, 201, r.text);
            ids.push(r.json.interaction.id);
        }
        const count = () => t.db.prepare('SELECT (SELECT COUNT(*) FROM paid_messages WHERE interaction_id IN (?, ?, ?)) + (SELECT COUNT(*) FROM paid_media_requests WHERE interaction_id IN (?, ?, ?)) AS n').get(...ids, ...ids).n;
        assert.strictEqual(count(), 0);
        for (const id of ids) await t.deliver(billing.settlePurchase(domain.interactions.get(id).billing_intent_id));
        await new Promise((ok) => setTimeout(ok, 100));
        await domain.interactions.processDueTransfers();
        assert.strictEqual(count(), 3);
        const pm = t.db.prepare('SELECT * FROM paid_messages WHERE interaction_id = ?').get(ids[0]);
        assert.strictEqual(pm.highlight_seconds, 60);
        await domain.effects.drain();
        assert.strictEqual(t.db.prepare('SELECT status FROM paid_messages WHERE interaction_id = ?').get(ids[1]).status, 'delivered');
        assert.strictEqual(t.db.prepare('SELECT status FROM paid_media_requests WHERE interaction_id = ?').get(ids[2]).status, 'accepted');
        const tts = t.adapters.test.jobs.find((j) => j.effect === 'tts' && j.interaction.id === ids[1]);
        assert.deepStrictEqual(tts.tts, { text: 'read me please', voice: 'amy' });
    });

    await check('an EXTERNAL PowerChat tip is recorded once by provider ref and kept out of the Billing total', async () => {
        const body = { creator: 'alex', provider: 'powerchat', provider_ref: 'evt-direct-1', amount_cents: 500, supporter_name: 'Fan', message: 'direct' };
        const a = await t.call('POST', '/api/v1/interactions/external', { cap: ['tips.interaction.record'], body });
        assert.strictEqual(a.status, 201, a.text);
        const b = await t.call('POST', '/api/v1/interactions/external', { cap: ['tips.interaction.record'], body });
        assert.strictEqual(b.status, 200);
        assert.strictEqual(b.json.duplicate, true);
        assert.strictEqual(a.json.interaction.id, b.json.interaction.id);
        const denied = await t.call('POST', '/api/v1/interactions/external', { cap: ['tips.checkout.create'], body: { ...body, provider_ref: 'x2' } });
        assert.strictEqual(denied.status, 403);
        const totals = domain.interactions.totals(alex.subject);
        assert.strictEqual(totals.external, 500);
    });

    await check('the Billing webhook: bad, v1-only and stale signatures refused, proxied requests hidden, other sources ignored', async () => {
        const ev = billing.foreignDonation({ from: null, to: alex.subject, amount: 5 });
        const bad = await t.deliver(ev, { secret: 'x'.repeat(48) });
        assert.strictEqual(bad.status, 401);
        assert.strictEqual((await t.deliver(ev, { v1Only: true })).status, 401, 'v1 only (no v2 header): refused');
        assert.strictEqual((await t.deliver(ev, { now: Date.now() - 301000 })).status, 401, 'stale v2 (outside the 300 s window): refused');
        const raw = JSON.stringify({ event: ev, seq: 1 });
        const { signDeliveryHeaders } = require('openvibe-sdk/events');
        const proxied = await fetch(`${t.base}/internal/events`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(raw, 'e'.repeat(48)), 'X-Forwarded-For': '203.0.113.9' } });
        assert.strictEqual(proxied.status, 404);
        const forged = await t.deliver({ ...ev, source: 'live' });
        assert.strictEqual(forged.json.outcome, 'ignored:source');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions WHERE billing_txn_id = ?').get(ev.payload.transaction_id).n, 0);
    });

    await check('events: ready/goal events are relayed to OpenVibe.Events with the tips service token', async () => {
        const flushed = await t.app.locals.outbox.outbox.flush();
        assert.ok(flushed.sent > 0, JSON.stringify(flushed));
        const types = new Set(t.events.published.map((e) => e.event_type));
        for (const ty of ['tips.interaction.ready', 'tips.goal.updated', 'tips.interaction.failed', 'tips.interaction.cancelled']) assert.ok(types.has(ty), `${ty} relayed`);
        assert.ok(t.events.published.every((e) => e.source === 'tips'));
        const grant = t.network.grants.find((g) => g.audience === 'openvibe.events');
        assert.strictEqual(grant.scope, 'events.event.publish');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
