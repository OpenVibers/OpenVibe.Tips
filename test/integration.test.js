'use strict';
// Tips on the production-shaped data tier (ADR-035; the tests of ADR-007's 2026-09-24 amendment):
// PostgreSQL 18 behind PgBouncer in transaction mode and Valkey 9, from
// `eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)"`. Two Tips processes (two app
// instances, each with its own pool and Valkey connection) share one database, one Valkey and the same
// Billing and Network:
//   - money races: one settlement or one reversal delivered many times at once, to both processes,
//     counts once; the unpaid-checkout limit holds under concurrent requests (serializable)
//   - work claimed with a lease: two effects workers and two transfer retries at once act once each
//   - per-process state in Valkey: per-actor limits, overlay fan-out (a stream on one process hears
//     tips, config changes and revocations made on the other), overlay stream slots
//   - flushing Valkey changes no money answer
// Without the containers it prints why it skipped; the rest of the suite runs on PGlite.
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { createValkey } = require('openvibe-sdk/valkey');
const { testDb, testValkey, pgAvailable, valkeyAvailable } = require('./helpers/db');
const { boot, check, done } = require('./helpers/app');

if (!pgAvailable()) {
    console.log('integration (PgBouncer + Valkey): skipped (OV_TEST_PG_URL not set; eval "$(node_modules/openvibe-sdk/scripts/test-services.sh up)")');
    process.exit(0);
}

const LIMIT_CLOCK = Date.UTC(2026, 8, 28, 12, 0, 10);   // one fixed minute for both processes' limiters

(async () => {
    const store = await testDb({ store: 'pg', max: 6 });
    const vA = testValkey();
    const vB = vA ? createValkey({ url: process.env.OV_TEST_VALKEY_URL, prefix: vA.prefix, log: { warn() {} } }) : null;
    const env = { TIPS_OVERLAY_MAX_STREAMS: '2', TIPS_MAX_PENDING_CHECKOUTS: '3' };
    const appOpts = { limitsNow: () => LIMIT_CLOCK };
    const A = await boot({ db: store.db, valkey: vA, env, appOpts });
    const dbB = store.open();
    const B = await boot({ db: dbB, valkey: vB, env, appOpts, share: A });
    const { billing } = A;
    const db = store.db;
    const alex = await A.creator('alex');
    const fan = A.network.newUser('fan');
    billing.fund(fan.subject, 1_000_000);
    const goal = (await A.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 100_000 } })).json.goal;
    const fresh = (e) => ({ ...e, event_id: ids.newId('event') });
    const both = (n, fn) => Promise.all(Array.from({ length: n }, (_, k) => fn(k % 2 ? B : A, k)));

    await check('the store is PostgreSQL through PgBouncer; Valkey answers', async () => {
        const r = await A.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.checks.db.detail.store, 'postgresql');
        assert.strictEqual(r.json.checks.valkey.status, vA ? 'ok' : 'skipped');
    });

    await check('one Billing settlement delivered 6 times at once, to both processes, settles once', async () => {
        const ev = billing.foreignDonation({ from: fan.subject, to: alex.subject, amount: 300, provider: 'powerchat' });
        const out = await both(6, (t) => t.deliver(fresh(ev)));
        assert.ok(out.every((r) => r.status === 200), JSON.stringify(out.map((r) => [r.status, r.json])));
        assert.deepStrictEqual(out.map((r) => r.json.outcome).sort(), ['duplicate_transaction', 'duplicate_transaction', 'duplicate_transaction', 'duplicate_transaction', 'duplicate_transaction', 'recorded']);
        const rows = await db.many('SELECT id FROM tip_interactions WHERE billing_txn_id = $1', [ev.payload.transaction_id]);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(await db.value('SELECT count(*) FROM tip_goal_contributions WHERE interaction_id = $1', [rows[0].id]), 1);
        assert.strictEqual((await A.outboxRows('tips.interaction.ready')).filter((e) => e.subject.id === rows[0].id).length, 1);
        assert.strictEqual(await db.value("SELECT count(*) FROM overlay_deliveries WHERE kind = 'alert' AND interaction_id = $1", [rows[0].id]), 1);
    });

    await check('one reversal delivered 6 times at once takes the bits back once, from the goal too', async () => {
        const r = await A.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 400, goal_id: goal.id } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json.interaction.id;
        const before = (await A.domain.goals.present(db, await A.domain.goals.get(db, goal.id))).current_amount;
        const rev = billing.refund(r.json.interaction.payment.billing_txn_id);
        const out = await both(6, (t) => t.deliver(fresh(rev)));
        assert.ok(out.every((x) => x.status === 200), JSON.stringify(out.map((x) => [x.status, x.json])));
        assert.strictEqual(out.filter((x) => x.json.outcome === 'duplicate_reversal').length, 5);
        const i = await db.one('SELECT reversed_bits, reversal_txn_ids, payment_state FROM tip_interactions WHERE id = $1', [id]);
        assert.deepStrictEqual([i.reversed_bits, i.reversal_txn_ids.length, i.payment_state], [400, 1, 'reversed']);
        assert.strictEqual((await A.domain.goals.present(db, await A.domain.goals.get(db, goal.id))).current_amount, before - 400);
        assert.strictEqual(await A.domain.interactions.totals(db, alex.subject).then((x) => x.settled_via_billing), billing.payable.get(alex.subject), 'reconciles with Billing');
    });

    await check('one Idempotency-Key sent at once to both processes runs once: one interaction, one Billing transfer', async () => {
        const key = `race-${Date.now()}-key`;
        const body = { creator: 'alex', amount: 33, message: 'once' };
        const out = await Promise.all([A, B, A, B].map((t) => t.call('POST', '/api/v1/checkout', { user: fan, body, key })));
        // The first runs; the others are told it is in progress (409, Retry-After) or get its stored answer.
        assert.ok(out.every((r) => r.status === 201 || (r.status === 409 && r.json.code === 'idempotency.in_progress')), JSON.stringify(out.map((r) => [r.status, r.json && r.json.code])));
        const ok = out.filter((r) => r.status === 201);
        assert.ok(ok.length >= 1);
        assert.strictEqual(new Set(ok.map((r) => r.json.interaction.id)).size, 1, 'every answer names the one interaction');
        const id = ok[0].json.interaction.id;
        assert.strictEqual(billing.transfers().filter((c) => c.key === `tips:transfer:${id}`).length, 1);
        assert.strictEqual(await db.value('SELECT count(*) FROM tip_interactions WHERE idempotency_key = $1', [`api:${fan.subject}:${key}`]), 1);
        const later = await B.call('POST', '/api/v1/checkout', { user: fan, body, key });
        assert.deepStrictEqual([later.status, later.headers.get('idempotent-replayed'), later.json.interaction.id], [201, 'true', id]);
    });

    await check('a creator\'s overlay deliveries become visible in seq order, however their transactions interleave', async () => {
        // T1 inserts a delivery and holds its transaction open; T2 (the other process) inserts one for the
        // same creator. T2 waits for T1, so seq order is commit order and no stream skips a seq.
        const view = { id: goal.id };
        let release;
        const hold = new Promise((ok) => { release = ok; });
        let t1Seq = null; let t2Done = false;
        const t1 = A.domain.tx(async (t) => {
            await A.domain.overlays.addGoalDelivery(t, alex.subject, view, { reason: 'test', dedupe: `seq-order-1-${Date.now()}` });
            t1Seq = await t.value('SELECT max(seq) FROM overlay_deliveries');
            await hold;
        });
        while (t1Seq === null) await new Promise((ok) => setTimeout(ok, 10));
        const t2 = B.domain.tx((t) => B.domain.overlays.addGoalDelivery(t, alex.subject, view, { reason: 'test', dedupe: `seq-order-2-${Date.now()}` })).then(() => { t2Done = true; });
        await new Promise((ok) => setTimeout(ok, 300));
        const waited = !t2Done;
        release();   // before any assertion, so a failure reports instead of holding the transaction
        await Promise.all([t1, t2]);
        assert.strictEqual(waited, true, 'the second insert waits for the first transaction');
        const [first, second] = (await db.many("SELECT seq FROM overlay_deliveries WHERE dedupe_key LIKE 'seq-order-%' ORDER BY seq")).map((r) => r.seq);
        assert.strictEqual(first, t1Seq);
        assert.ok(second > first);
        // Another creator is not held up by it.
        const other = A.network.newUser('other-creator');
        let otherDone = false;
        let release2;
        const hold2 = new Promise((ok) => { release2 = ok; });
        const t3 = A.domain.tx(async (t) => { await A.domain.overlays.addGoalDelivery(t, alex.subject, view, { reason: 'test', dedupe: `seq-order-3-${Date.now()}` }); await hold2; });
        await new Promise((ok) => setTimeout(ok, 50));
        const t4 = B.domain.tx((t) => B.domain.overlays.addGoalDelivery(t, other.subject, view, { reason: 'test', dedupe: `seq-order-4-${Date.now()}` })).then(() => { otherDone = true; });
        await Promise.race([t4, new Promise((ok) => setTimeout(ok, 2000))]);
        const unblocked = otherDone;
        release2();
        await Promise.all([t3, t4]);
        assert.strictEqual(unblocked, true, 'another creator\'s insert does not wait');
    });

    await check('the unpaid-checkout limit (3) holds for 6 concurrent requests on two processes', async () => {
        const buyer = A.network.newUser('buyer');
        const out = await both(6, (t, k) => t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 100 + k, pay_with: 'checkout', provider: 'stripe' } }));
        assert.deepStrictEqual(out.map((r) => r.status).sort(), [201, 201, 201, 429, 429, 429], JSON.stringify(out.map((r) => r.json && r.json.code)));
        assert.ok(out.filter((r) => r.status === 429).every((r) => r.json.code === 'tips.too_many_pending'));
        assert.strictEqual(await db.value("SELECT count(*) FROM tip_interactions WHERE supporter_subject = $1 AND payment_state = 'pending'", [buyer.subject]), 3);
    });

    await check('two effects workers draining at once deliver each chat line once (leased claims)', async () => {
        const ids6 = [];
        for (let k = 0; k < 6; k++) ids6.push((await A.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 10 + k, message: `m${k}` } })).json.interaction.id);
        await Promise.all([A.domain.effects.drain(), B.domain.effects.drain(), A.domain.effects.drain(), B.domain.effects.drain()]);
        const jobs = [...A.adapters.test.jobs, ...B.adapters.test.jobs].filter((j) => ids6.includes(j.interaction.id));
        const per = new Map();
        for (const j of jobs) per.set(j.delivery_id, (per.get(j.delivery_id) || 0) + 1);
        assert.strictEqual(per.size, 6);
        assert.ok([...per.values()].every((n) => n === 1), JSON.stringify([...per]));
        assert.strictEqual(await db.value("SELECT count(*) FROM tip_interactions WHERE id = ANY($1) AND delivery_state = 'delivered'", [ids6]), 6);
    });

    await check('two processes retrying due transfers at once call Billing once per tip', async () => {
        billing.state.down = true;
        const pending = [];
        for (let k = 0; k < 4; k++) pending.push((await A.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 20 + k } })).json.interaction.id);
        billing.state.down = false;
        const mark = billing.calls.length;
        A.clock.offset = B.clock.offset = 60_000;
        await Promise.all([A.domain.interactions.processDueTransfers(), B.domain.interactions.processDueTransfers(), A.domain.interactions.processDueTransfers()]);
        A.clock.offset = B.clock.offset = 0;
        const calls = billing.calls.slice(mark).filter((c) => c.url === '/api/v1/transfers');
        assert.deepStrictEqual(calls.map((c) => c.key).sort(), pending.map((id) => `tips:transfer:${id}`).sort(), 'one call each');
        assert.strictEqual(await db.value("SELECT count(*) FROM tip_interactions WHERE id = ANY($1) AND payment_state = 'settled'", [pending]), 4);
    });

    if (!valkeyAvailable()) {
        console.log('integration, shared state in Valkey: skipped (OV_TEST_VALKEY_URL not set)');
    } else {
        await check('per-actor limits are counted across processes (POST /me/erase: 3 a minute a person)', async () => {
            const person = A.network.newUser('eraser');
            const codes = [];
            for (const t of [A, B, A, B]) codes.push((await t.call('POST', '/api/v1/me/erase', { user: person })).status);
            assert.deepStrictEqual(codes, [200, 200, 200, 429]);
        });

        let secret;
        let cfg;
        await check('a stream on process A hears a tip, a config change and a revocation made on process B', async () => {
            cfg = (await B.call('POST', '/api/v1/overlay-configs', { user: alex, body: { kind: 'alerts', name: 'Main' } })).json.config;
            const tok = (await B.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts', 'goals'], config_id: cfg.id } })).json;
            secret = tok.secret;
            const s = await A.sse(`/overlay/${secret}/events`);
            await s.waitFor((e) => e.event === 'hello');
            const r = await B.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 77, message: 'from B' } });
            const alert = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === r.json.interaction.id);
            assert.strictEqual(alert.data.amount, 77);
            await B.call('PATCH', `/api/v1/overlay-configs/${cfg.id}`, { user: alex, body: { duration_ms: 4000 } });
            const c = await s.waitFor((e) => e.event === 'config');
            assert.strictEqual(c.data.config.settings.duration_ms, 4000);
            await B.call('POST', `/api/v1/overlay-tokens/${tok.token.id}/revoke`, { user: alex });
            assert.ok(await s.waitFor((e) => e.event === 'revoked'));
            await new Promise((ok) => setTimeout(ok, 100));
            assert.strictEqual(s.ended, true);
        });

        await check('overlay stream slots (2 a token) are counted across processes', async () => {
            const tok = (await A.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts'] } })).json.secret;
            const s1 = await A.sse(`/overlay/${tok}/events`);
            const s2 = await B.sse(`/overlay/${tok}/events`);
            assert.deepStrictEqual([s1.statusCode, s2.statusCode], [200, 200]);
            assert.strictEqual((await fetch(`${A.base}/overlay/${tok}/events`)).status, 429, 'the third stream, on either process');
            assert.strictEqual(await B.domain.overlays.connected(alex.subject), 2);
            s1.close();
            await new Promise((ok) => setTimeout(ok, 150));
            const s3 = await B.sse(`/overlay/${tok}/events`);
            assert.strictEqual(s3.statusCode, 200, 'a closed stream frees its place for the other process');
            s2.close(); s3.close();
        });

        await check('flushing Valkey changes no money answer', async () => {
            const snapshot = async () => ({
                totals: await A.domain.interactions.totals(db, alex.subject),
                goal: (await A.domain.goals.present(db, await A.domain.goals.get(db, goal.id))).current_amount,
                receipts: (await B.call('GET', '/api/v1/interactions?limit=200', { user: fan })).json.interactions.map((i) => [i.id, i.payment.state, i.amount]),
            });
            const before = await snapshot();
            let cursor = '0'; let deleted = 0;
            do {
                const [next, keys] = await vA.client.scan(cursor, 'MATCH', `${vA.prefix}*`, 'COUNT', 500);
                cursor = next;
                if (keys.length) deleted += await vA.client.del(...keys);
            } while (cursor !== '0');
            assert.ok(deleted > 0, 'there was shared state to lose');
            assert.deepStrictEqual(await snapshot(), before);
            assert.strictEqual(before.totals.settled_via_billing, billing.payable.get(alex.subject), 'and it still reconciles with Billing');
            const r = await B.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 5 } });
            assert.strictEqual(r.json.interaction.payment.state, 'settled', 'tips still settle');
        });
    }

    await B.close();
    await A.close();
    await dbB.close();
    await store.close();
    if (vA) { await vA.close(); await vB.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
