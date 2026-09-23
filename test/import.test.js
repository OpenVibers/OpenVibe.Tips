'use strict';
// Import from a Live snapshot, linked to Billing's imported journal, with the reconciliation:
// creator totals must equal Billing's. Fixtures follow Live's schema and Billing's importer keys.
const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const { boot, check, done } = require('./helpers/app');

function liveFixture(file) {
    const db = new Database(file);
    db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, openvibe_bucks_balance INTEGER DEFAULT 0);
        CREATE TABLE transactions (id INTEGER PRIMARY KEY, from_user_id INTEGER, to_user_id INTEGER, stream_id INTEGER, amount INTEGER NOT NULL,
            type TEXT NOT NULL, status TEXT DEFAULT 'completed', message TEXT, paypal_transaction_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, stream_id INTEGER, channel_user_id INTEGER, user_id INTEGER, username TEXT, message TEXT,
            message_type TEXT DEFAULT 'chat', metadata TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE donation_goals (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, target_amount INTEGER, current_amount INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1, image_url TEXT, media_type TEXT, reached_at DATETIME, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    const u = db.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)');
    [[1, 'alex', 'Alex'], [2, 'viewer', 'Viewer'], [3, 'ghost', 'Ghost'], [4, 'held', 'Held'], [5, 'bob', 'Bob']].forEach((r) => u.run(...r));
    db.prepare("INSERT INTO site_settings (key, value) VALUES ('stats_vibes_reset_at', '2026-01-01T00:00:00.000Z')").run();
    const t = db.prepare('INSERT INTO transactions (id, from_user_id, to_user_id, stream_id, amount, type, status, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    t.run(1, 2, 1, 7, 100, 'donation', 'completed', 'test era', '2025-12-01 10:00:00');
    t.run(2, 2, 1, 7, 500, 'donation', 'completed', 'nice', '2026-02-01 10:00:00');
    t.run(3, 3, 1, null, 200, 'donation', 'completed', null, '2026-02-02 10:00:00');
    t.run(4, 2, 4, null, 300, 'donation', 'completed', null, '2026-02-02 11:00:00');
    t.run(5, 2, 1, null, 50, 'donation', 'failed', null, '2026-02-02 12:00:00');
    t.run(6, 2, 1, 7, 250, 'donation', 'completed', 'Media request: Song', '2026-02-03 10:00:00');
    t.run(7, 1, 2, null, 250, 'refund', 'completed', 'Refund: Song', '2026-02-04 10:00:00');
    t.run(8, null, 5, null, 1000, 'donation', 'completed', 'PowerChat tip via site account ($10.00)', '2026-02-05 12:00:00');
    t.run(9, null, 2, null, 1000, 'purchase', 'completed', null, '2026-01-20 12:00:00');
    const c = db.prepare("INSERT INTO chat_messages (id, channel_user_id, username, message, message_type, metadata, created_at) VALUES (?, ?, ?, ?, 'donation', ?, ?)");
    c.run(1, 5, 'Fan', 'Fan tipped 1000 Vibes (PowerChat)', JSON.stringify({ kind: 'donation', amount: 1000, message: '', username: 'Fan', source: 'powerchat' }), '2026-02-05 12:00:30');
    c.run(2, 1, 'Direct', 'Direct tipped 700 Vibes (PowerChat)', JSON.stringify({ kind: 'donation', amount: 700, message: 'love it', username: 'Direct', source: 'powerchat' }), '2026-02-06 09:00:00');
    c.run(3, 1, 'Viewer', 'Viewer donated 500 Vibes: nice', JSON.stringify({ kind: 'donation', amount: 500, username: 'Viewer' }), '2026-02-01 10:00:01');
    const g = db.prepare('INSERT INTO donation_goals (id, user_id, title, target_amount, current_amount, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    g.run(1, 1, 'Synth', 5000, 1200, 1, '2026-01-10 10:00:00');
    g.run(2, 4, 'Held goal', 100, 0, 1, '2026-01-10 10:00:00');
    return db;
}

/** The rows OpenVibe.Billing's importer writes for that snapshot (server/importer/live.js keys). */
function billingFixture(file, subjects, { withNative = false } = {}) {
    const db = new Database(file);
    db.exec(`CREATE TABLE transactions (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT UNIQUE, reverses_txn TEXT,
        test INTEGER NOT NULL DEFAULT 0, from_subject TEXT, to_subject TEXT, provider TEXT, receipt_ref TEXT, metadata TEXT, created_at TEXT)`);
    const ins = db.prepare('INSERT INTO transactions (id, type, status, idempotency_key, reverses_txn, test, from_subject, to_subject, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const live = [
        [1, 2, 1, 100, 'donation', 'completed', true], [2, 2, 1, 500, 'donation', 'completed'], [3, 3, 1, 200, 'donation', 'completed'],
        [4, 2, 4, 300, 'donation', 'completed'], [5, 2, 1, 50, 'donation', 'failed'], [6, 2, 1, 250, 'donation', 'completed'],
        [7, 1, 2, 250, 'refund', 'completed'], [8, null, 5, 1000, 'donation', 'completed'], [9, null, 2, 1000, 'purchase', 'completed'],
    ];
    for (const [id, from, to, amount, type, status, test] of live) {
        const note = status === 'completed' ? null : `status ${status}: no balance moved`;
        ins.run(`txn_import_${id}`, 'import', 'imported', `import:live:txn:${id}`, null, test ? 1 : 0, from ? subjects[from] || null : null, to ? subjects[to] || null : null,
            JSON.stringify({ live: { id, type, status, amount, from_user_id: from, to_user_id: to }, note }), '2026-09-22T00:00:00Z');
    }
    if (withNative) {
        ins.run('txn_native_1', 'donation', 'settled', 'api:svc:live:k1', null, 0, subjects[2], subjects[1], JSON.stringify({ kind: 'donation', amount_bits: 40 }), '2026-09-22T01:00:00Z');
        ins.run('txn_native_test', 'donation', 'settled', 'api:svc:live:k2', null, 1, subjects[2], subjects[1], JSON.stringify({ kind: 'donation', amount_bits: 999 }), '2026-09-22T01:00:00Z');
    }
    return db;
}

(async () => {
    const t = await boot();
    const { domain } = t;
    const { importLive, billingSnapshotSource } = require('../server/importer/live');
    const { createIdentity } = require('../server/network');
    const identity = createIdentity(t.config);
    const users = { 1: t.network.newUser('alex', 1), 2: t.network.newUser('viewer', 2), 5: t.network.newUser('bob', 5) };
    const subjects = { 1: users[1].subject, 2: users[2].subject, 5: users[5].subject };
    const live = liveFixture(path.join(t.dir, 'live-snapshot.db'));
    const bdb = billingFixture(path.join(t.dir, 'billing-snapshot.db'), subjects, { withNative: true });
    const quiet = { log() {} };
    const run = (opts = {}) => importLive(domain, { live, billingSource: billingSnapshotSource(bdb), resolveLiveUsers: identity.resolveLiveUsers, log: quiet, ...opts });

    await check('a dry run reports and keeps nothing', async () => {
        const r = await run({ dryRun: true });
        assert.strictEqual(r.dry_run, true);
        assert.ok(r.counts.imported > 0);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n, 0);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM migration_maps').get().n, 0);
    });

    let report;
    await check('donations import settled and linked to Billing; failed excluded; unmapped creators held; test era flagged', async () => {
        report = await run();
        const byLegacy = (id) => t.db.prepare('SELECT * FROM tip_interactions WHERE legacy_source = ?').get(`live:transactions:${id}`);
        const two = byLegacy(2);
        assert.strictEqual(two.payment_state, 'settled');
        assert.strictEqual(two.settlement, 'imported');
        assert.strictEqual(two.billing_txn_id, 'txn_import_2');
        assert.strictEqual(two.supporter_subject, subjects[2]);
        assert.strictEqual(two.message, 'nice');
        assert.strictEqual(two.created_at, '2026-02-01T10:00:00.000Z');
        assert.strictEqual(byLegacy(1).test, 1, 'before stats_vibes_reset_at');
        const ghost = byLegacy(3);
        assert.strictEqual(ghost.supporter_subject, null);
        assert.strictEqual(ghost.supporter_name, 'Ghost');
        assert.strictEqual(byLegacy(6).kind, 'media_request');
        assert.strictEqual(byLegacy(8).funding, 'provider');
        assert.strictEqual(byLegacy(4), undefined, 'held, not dropped');
        const held = t.db.prepare("SELECT * FROM migration_maps WHERE source_table = 'transactions' AND source_id = '4'").get();
        assert.strictEqual(held.status, 'held');
        const excluded = t.db.prepare("SELECT * FROM migration_maps WHERE source_table = 'transactions' AND source_id = '5'").get();
        assert.strictEqual(excluded.status, 'excluded');
        assert.match(excluded.reason, /status failed/);
        assert.strictEqual(report.counts.linked_to_billing, report.counts.imported);
        // Imports are history: no effects, no overlay alerts, no events.
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM interaction_effects').get().n, 0);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM overlay_deliveries').get().n, 0);
        assert.strictEqual(t.outboxRows('tips.interaction.ready').length, 0);
    });

    await check('the refund nets out against the donation it undoes', async () => {
        const six = t.db.prepare("SELECT * FROM tip_interactions WHERE legacy_source = 'live:transactions:6'").get();
        assert.strictEqual(six.reversed_bits, 250);
        assert.strictEqual(six.payment_state, 'reversed');
        assert.strictEqual(report.counts.refunds_applied, 1);
    });

    await check('external PowerChat tips: the direct one is imported as EXTERNAL; the site-routed celebration is not counted twice', async () => {
        const ext = t.db.prepare("SELECT * FROM tip_interactions WHERE legacy_source = 'live:chat_messages:2'").get();
        assert.strictEqual(ext.settlement, 'external');
        assert.strictEqual(ext.amount, 700);
        assert.strictEqual(ext.supporter_name, 'Direct');
        const twin = t.db.prepare("SELECT * FROM migration_maps WHERE source_table = 'chat_messages' AND source_id = '1'").get();
        assert.strictEqual(twin.status, 'excluded');
        assert.match(twin.reason, /site-routed tip \(Live transaction 8\)/);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM migration_maps WHERE source_table = 'chat_messages' AND source_id = '3'").get().n, 0, 'on-site donation lines are not PowerChat');
    });

    await check('goals import with Live\'s current amount carried over (not invented contributions)', async () => {
        const g = t.db.prepare("SELECT * FROM tip_goals WHERE legacy_source = 'live:donation_goals:1'").get();
        const view = domain.goals.present(g);
        assert.strictEqual(view.current_amount, 1200);
        assert.strictEqual(view.carried_over_amount, 1200);
        assert.strictEqual(view.supporters_count, 0);
    });

    await check('reconciliation: a Billing donation Tips never saw is reported, not absorbed', async () => {
        const r = report.reconciliation;
        assert.strictEqual(r.ok, false);
        assert.deepStrictEqual(r.mismatches, [{ creator: subjects[1], tips: 700, billing: 740, difference: -40 }]);
        assert.ok(r.rows.find((x) => x.creator === subjects[5] && x.tips === 1000 && x.billing === 1000));
    });

    await check('once the Billing event arrives, creator totals equal Billing exactly (test money excluded on both sides)', async () => {
        const ev = t.billing.envelope('billing.transaction.settled', { transaction_id: 'txn_native_1', type: 'donation', test: false, from_subject: subjects[2], to_subject: subjects[1], provider: null, metadata: { kind: 'donation', amount_bits: 40 } }, 'txn_native_1');
        assert.strictEqual((await t.deliver(ev)).json.outcome, 'recorded');
        const evTest = t.billing.envelope('billing.transaction.settled', { transaction_id: 'txn_native_test', type: 'donation', test: true, from_subject: subjects[2], to_subject: subjects[1], provider: null, metadata: { kind: 'donation', amount_bits: 999 } }, 'txn_native_test');
        await t.deliver(evTest);
        const { reconcile } = require('../server/importer/live');
        const r = reconcile(domain, billingSnapshotSource(bdb));
        assert.strictEqual(r.ok, true, JSON.stringify(r.mismatches));
        assert.strictEqual(domain.interactions.totals(subjects[1]).settled_via_billing, 740);
        assert.strictEqual(domain.interactions.totals(subjects[1]).external, 700);
    });

    await check('a re-run changes nothing; a newly mapped creator is released from hold', async () => {
        const before = t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n;
        const again = await run();
        assert.strictEqual(again.counts.imported, 0);
        assert.strictEqual(again.counts.goals, 0);
        assert.ok(again.counts.unchanged > 0);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions').get().n, before);
        const heldUser = t.network.newUser('held', 4);
        const r = await run();
        assert.strictEqual(r.counts.released, 1);
        assert.strictEqual(r.counts.goals, 1);
        const four = t.db.prepare("SELECT * FROM tip_interactions WHERE legacy_source = 'live:transactions:4'").get();
        assert.strictEqual(four.creator_subject, heldUser.subject);
        assert.strictEqual(four.billing_txn_id, 'txn_import_4');
        assert.strictEqual(t.db.prepare("SELECT status FROM migration_maps WHERE source_table = 'transactions' AND source_id = '4'").get().status, 'imported');
    });

    await check('every source row is imported, excluded with a reason, or held — none silently dropped', async () => {
        const tipRows = live.prepare("SELECT id FROM transactions WHERE type IN ('donation', 'refund')").all().map((x) => String(x.id));
        const mapped = new Set(t.db.prepare("SELECT source_id FROM migration_maps WHERE source_table = 'transactions'").all().map((x) => x.source_id));
        assert.deepStrictEqual(tipRows.filter((id) => !mapped.has(id)), []);
        const excluded = t.db.prepare("SELECT * FROM migration_maps WHERE status = 'excluded'").all();
        assert.ok(excluded.every((x) => x.reason));
    });

    live.close(); bdb.close();
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
