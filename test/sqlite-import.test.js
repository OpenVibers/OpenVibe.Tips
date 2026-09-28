'use strict';
// The one-time import (ADR-035; scripts/migrate-to-postgres.js): a SQLite file with the last SQLite
// release's schema (test/fixtures/sqlite-v3-schema.sql) and rows of every table goes through
// openvibe-sdk's importSqlite into the migrated schema: report.ok, every row counted and checksummed,
// values converted by column type (0/1 → boolean, ISO text → timestamptz, JSON text → jsonb), identities
// kept and continued, the SQLite file untouched; and the service then serves the imported data.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { ids } = require('openvibe-contracts');
const { importSqlite } = require('openvibe-sdk/db');
const { testDb } = require('./helpers/db');
const { boot, check, done } = require('./helpers/app');
const { importOptions } = require('../scripts/migrate-to-postgres');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tips-import-'));
const quiet = { log() {} };
const creator = ids.newId('user');
const supporter = ids.newId('user');
const T = (s) => `2026-09-${s}Z`;   // an ISO time, as the SQLite release wrote them

/** A SQLite file as the SQLite release left it: its schema and a few rows in every table. */
function fixture(file) {
    const s = new Database(file);
    s.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'sqlite-v3-schema.sql'), 'utf8'));
    const ins = (table, row) => s.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
    ins('settings', { id: 1, schema_version: 3, created_at: T('01T00:00:00.000') });
    ins('creator_tip_profiles', {
        creator_subject: creator, handle: 'alex', display_name: 'Alex', page_enabled: 1, accepting: 1, tts_enabled: 0, media_requests_enabled: 1,
        revision: 4, created_at: T('01T10:00:00.000'), updated_at: T('02T11:30:00.250'),
        page_settings: '{"goal_amounts":false,"supporters_page":true}', filter_words: '["badword","two words"]', filter_action: 'hold', filter_links: 0,
    });
    const tip = (id, fields) => ins('tip_interactions', {
        id, creator_subject: creator, supporter_subject: supporter, supporter_name: 'Viewer', kind: 'tip', amount: 250, funding: 'credit', settlement: 'billing',
        payment_state: 'settled', delivery_state: 'delivered', created_at: T('03T12:00:00.000'), updated_at: T('03T12:00:01.000'), settled_at: T('03T12:00:00.500'), ...fields,
    });
    tip('tint_01', { billing_txn_id: 'txn_1', request: '{"goal_id":"tgoal_01"}', target: '{"service":"live","type":"stream","id":"42"}', message: 'great stream' });
    // Two things SQLite took and PostgreSQL does not: a NUL in text, an unpaired surrogate inside JSON.
    tip('tint_02', { message: 'nul\u0000here', request: '{"legacy_message":"cut \\ud83d","n":1}', billing_txn_id: 'txn_2', payment_state: 'reversed', reversal_txn_ids: '["txn_9"]', reversed_bits: 100, reversed_at: T('04T09:00:00.000'), anonymous: 1, hide_amount: 1, test: 0 });
    tip('tint_03', { kind: 'paid_message', amount: 500, message: 'hello chat', funding: 'checkout', payment_state: 'pending', delivery_state: 'awaiting_payment',
        settled_at: null, billing_intent_id: 'pi_1', checkout_url: 'https://checkout.example/pi_1', idempotency_key: 'api:usr:k1', transfer_due: 1, transfer_attempts: 2, next_transfer_at: 1790600000123 });
    tip('tint_04', { supporter_subject: null, supporter_name: null, erased_at: T('05T08:00:00.000'), moderation: 'hidden', moderated_by: 'filter', filtered: 1, test: 1, origin: 'import',
        settlement: 'imported', legacy_source: 'live:transactions:7', provider: 'powerchat', provider_ref: 'live-chat:3', request: '{}' });
    ins('tip_goals', { id: 'tgoal_01', creator_subject: creator, title: 'Desk', target_amount: 1000, status: 'active', opening_amount: 50, created_at: T('02T00:00:00.000'), updated_at: T('02T00:00:00.000'), reached_at: null });
    ins('tip_goal_contributions', { id: 7, goal_id: 'tgoal_01', interaction_id: 'tint_01', amount: 250, reversed_amount: 0, created_at: T('03T12:00:00.600'), updated_at: T('03T12:00:00.600') });
    ins('tip_goal_contributions', { id: 12, goal_id: 'tgoal_01', interaction_id: 'tint_02', amount: 250, reversed_amount: 100, created_at: T('03T12:00:00.700'), updated_at: T('04T09:00:00.000') });
    ins('paid_messages', { id: 'tpm_01', interaction_id: 'tint_01', creator_subject: creator, kind: 'paid_message', text: 'hello', highlight_seconds: 30, status: 'delivered', chat_ref: 'null', test: 0, created_at: T('03T12:00:01.000'), updated_at: T('03T12:00:02.000') });
    ins('paid_media_requests', { id: 'tmr_01', interaction_id: 'tint_02', creator_subject: creator, url: 'https://youtu.be/x', provider: 'youtube', status: 'accepted', queue_ref: '{"queue_id":5}', created_at: T('03T12:00:01.000'), updated_at: T('03T12:00:02.000') });
    ins('overlay_configs', { id: 'tovc_01', creator_subject: creator, kind: 'alerts', name: 'Alerts', settings: '{"min_amount":1,"sound_url":null}', revision: 2, created_at: T('02T00:00:00.000'), updated_at: T('02T00:00:00.000') });
    ins('overlay_tokens', { id: 'tovt_01', creator_subject: creator, token_hash: 'a'.repeat(64), scopes: '["alerts","goals"]', config_id: 'tovc_01', created_by: creator, created_at: T('02T00:00:00.000'), revoked_at: T('06T00:00:00.000') });
    ins('overlay_deliveries', { seq: 3, id: 'tovd_03', creator_subject: creator, kind: 'alert', interaction_id: 'tint_01', payload: '{"interaction_id":"tint_01","amount":250}', status: 'delivered', sends: 4, dedupe_key: 'alert:tint_01', created_at: T('03T12:00:01.000'), delivered_at: T('03T12:00:01.500'), hidden: 0 });
    ins('overlay_deliveries', { seq: 9, id: 'tovd_09', creator_subject: creator, kind: 'goal', goal_id: 'tgoal_01', payload: '{"goal":{"id":"tgoal_01"},"by":null}', status: 'pending', dedupe_key: 'goal:tgoal_01:r2', created_at: T('03T12:00:01.000'), hidden: 1 });
    ins('interaction_effects', { id: 4, interaction_id: 'tint_01', effect: 'chat_line', adapter: 'live-chat', state: 'delivered', attempts: 1, result: '{"ref":{"chat_message_id":1}}', created_at: T('03T12:00:01.000'), updated_at: T('03T12:00:02.000') });
    ins('interaction_effects', { id: 5, interaction_id: 'tint_01', effect: 'overlay_alert', adapter: 'overlay', state: 'delivered', result: 'null', created_at: T('03T12:00:01.000'), updated_at: T('03T12:00:01.000') });
    ins('interaction_effects', { id: 6, interaction_id: 'tint_03', effect: 'paid_message', adapter: 'live-chat', state: 'queued', attempts: 2, next_attempt_at: 1790600000999, last_error: 'Live 503', created_at: T('03T12:00:01.000'), updated_at: T('03T12:00:01.000') });
    ins('migration_maps', { id: 2, source: 'live', source_table: 'transactions', source_id: '7', target_type: 'interaction', target_id: 'tint_04', status: 'imported', run_id: 'timp_1', created_at: T('01T00:00:00.000'), updated_at: T('01T00:00:00.000') });
    ins('import_runs', { id: 'timp_1', source: 'live', dry_run: 0, started_at: T('01T00:00:00.000'), finished_at: T('01T00:00:05.000'), report: '{"counts":{"imported":1},"holds":[]}' });
    ins('tip_moderators', { creator_subject: creator, moderator_subject: supporter, name: 'Mod', added_by: 'invite:tmin_1', created_at: T('02T00:00:00.000') });
    ins('tip_moderator_invites', { id: 'tmin_1', creator_subject: creator, token_hash: 'b'.repeat(64), created_by: creator, created_at: T('02T00:00:00.000'), expires_at: T('09T00:00:00.000'), used_at: T('02T01:00:00.000'), used_by: supporter });
    ins('tip_moderation_log', { id: 3, creator_subject: creator, interaction_id: 'tint_04', action: 'hidden', by_role: 'moderator', actor: supporter, reason: 'abuse', created_at: T('05T08:00:00.000') });
    // A stored answer is replayed byte for byte: its text keeps its key order and spacing.
    ins('api_idempotency', { key: `${supporter}:tip-key-0001`, request_hash: 'h1', method: 'POST', path: '/api/v1/checkout', status: 201, response: '{"z":1,"a":{"b":2}}', created_at: T('03T12:00:00.000') });
    ins('event_outbox', { id: 1, event_id: 'evt_01', envelope: '{"event_type":"tips.interaction.ready","subject":{"type":"interaction","id":"tint_01"},"payload":{"supporter":null}}', created_at: 1790500000000, attempts: 1, sent_at: 1790500001000, seq: 17 });
    ins('event_outbox', { id: 2, event_id: 'evt_02', envelope: '{"event_type":"tips.goal.updated","subject":{"type":"goal","id":"tgoal_01"},"payload":{}}', created_at: 1790500002000, attempts: 3, next_attempt_at: 1790500999000, last_error: 'timeout' });
    ins('idempotency_receipts', { consumer: 'tips-billing', event_id: 'evt_billing_1', processed_at: 1790500000500 });
    s.close();
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

(async () => {
    const file = path.join(tmp, 'tips.db');
    const hash = fixture(file);

    const imported = await testDb({ store: 'pglite' });
    const db = imported.db;
    let report;
    const options = await importOptions(db);
    const TABLES = options.tables;
    await check('the importer copies every table, verified by counts and checksums (report.ok)', async () => {
        report = await importSqlite({ sqlite: file, db, truncate: true, tables: TABLES, log: quiet });
        assert.strictEqual(report.ok, true, JSON.stringify(report.problems));
        const rows = Object.fromEntries(report.tables.map((t) => [t.table, t.rows]));
        assert.deepStrictEqual(rows, {
            creator_tip_profiles: 1, tip_interactions: 4, tip_goals: 1, tip_goal_contributions: 2, paid_messages: 1, paid_media_requests: 1,
            overlay_configs: 1, overlay_tokens: 1, overlay_deliveries: 2, interaction_effects: 3, migration_maps: 1, import_runs: 1,
            tip_moderators: 1, tip_moderator_invites: 1, tip_moderation_log: 1, api_idempotency: 1, tips_event_outbox: 2, tips_event_inbox: 1,
        });
        assert.ok(report.tables.every((t) => /^[0-9a-f]{16}$/.test(t.checksum)), 'a checksum per table');
        const renamed = report.tables.filter((t) => t.source !== t.table).map((t) => `${t.source} → ${t.table}`).sort();
        assert.deepStrictEqual(renamed, ['event_outbox → tips_event_outbox', 'idempotency_receipts → tips_event_inbox']);
        assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, 'the SQLite file is unchanged');
    });

    await check('values are converted by column type', async () => {
        const p = await db.one('SELECT * FROM creator_tip_profiles');
        assert.deepStrictEqual([p.page_enabled, p.tts_enabled, p.filter_links, p.revision], [true, false, false, 4]);
        assert.deepStrictEqual(p.page_settings, { goal_amounts: false, supporters_page: true });
        assert.deepStrictEqual(p.filter_words, ['badword', 'two words']);
        assert.strictEqual(p.updated_at, T('02T11:30:00.250'), 'the same ISO time the API sent before');
        const i = await db.one("SELECT * FROM tip_interactions WHERE id = 'tint_01'");
        assert.deepStrictEqual(i.request, { goal_id: 'tgoal_01' });
        assert.deepStrictEqual(i.target, { service: 'live', type: 'stream', id: '42' });
        assert.deepStrictEqual([i.test, i.anonymous, i.transfer_due, i.amount], [false, false, false, 250]);
        assert.deepStrictEqual(i.reversal_txn_ids, []);
        const r = await db.one("SELECT * FROM tip_interactions WHERE id = 'tint_02'");
        assert.deepStrictEqual([r.anonymous, r.hide_amount, r.reversed_bits, r.reversal_txn_ids], [true, true, 100, ['txn_9']]);
        assert.strictEqual(r.message, 'nulhere', 'a NUL is dropped (PostgreSQL text cannot hold it)');
        assert.deepStrictEqual(r.request, { legacy_message: 'cut \ufffd', n: 1 }, 'an unpaired surrogate becomes U+FFFD (jsonb refuses it)');
        assert.deepStrictEqual(options.cleaned().sort((a, b) => a.column.localeCompare(b.column)),
            [{ column: 'tip_interactions.message', values: 1 }, { column: 'tip_interactions.request', values: 1 }], 'and the report says where');
        const pending = await db.one("SELECT * FROM tip_interactions WHERE id = 'tint_03'");
        assert.deepStrictEqual([pending.transfer_due, pending.transfer_attempts, pending.next_transfer_at, pending.settled_at], [true, 2, 1790600000123, null]);
        const erased = await db.one("SELECT * FROM tip_interactions WHERE id = 'tint_04'");
        assert.deepStrictEqual([erased.test, erased.filtered, erased.erased_at, erased.target], [true, true, T('05T08:00:00.000'), null]);
        assert.strictEqual(await db.value("SELECT chat_ref FROM paid_messages WHERE id = 'tpm_01'"), null, "JSON text 'null' → NULL (no reference)");
        assert.deepStrictEqual(await db.value("SELECT queue_ref FROM paid_media_requests WHERE id = 'tmr_01'"), { queue_id: 5 });
        assert.deepStrictEqual((await db.many('SELECT id, result FROM interaction_effects ORDER BY id')).map((e) => [e.id, e.result]),
            [[4, { ref: { chat_message_id: 1 } }], [5, null], [6, null]]);
        assert.deepStrictEqual(await db.value("SELECT scopes FROM overlay_tokens"), ['alerts', 'goals']);
        assert.deepStrictEqual((await db.many('SELECT seq, hidden, test FROM overlay_deliveries ORDER BY seq')).map((d) => [d.seq, d.hidden, d.test]), [[3, false, false], [9, true, false]]);
        assert.strictEqual(await db.value('SELECT response FROM api_idempotency'), '{"z":1,"a":{"b":2}}', 'a stored answer stays byte for byte');
        assert.strictEqual(await db.value('SELECT dry_run FROM import_runs'), false);
        const out = await db.many('SELECT id, envelope, sent_at, next_attempt_at FROM tips_event_outbox ORDER BY id');
        assert.deepStrictEqual(out.map((o) => [o.id, o.envelope.event_type, o.sent_at, o.next_attempt_at]), [[1, 'tips.interaction.ready', 1790500001000, 0], [2, 'tips.goal.updated', null, 1790500999000]]);
        assert.deepStrictEqual(await db.one('SELECT * FROM tips_event_inbox'), { consumer: 'tips-billing', event_id: 'evt_billing_1', processed_at: 1790500000500 });
    });

    await check('identities keep their values and continue after the imported maximum', async () => {
        const at = new Date().toISOString();
        assert.strictEqual(await db.value(`INSERT INTO overlay_deliveries (id, creator_subject, kind, payload, status, dedupe_key, created_at)
            VALUES ('tovd_new', $1, 'alert', '{}', 'pending', 'alert:new', $2) RETURNING seq`, [creator, at]), 10, 'the SSE ids go on from 9');
        assert.strictEqual(await db.value(`INSERT INTO interaction_effects (interaction_id, effect, adapter, state, created_at, updated_at)
            VALUES ('tint_02', 'chat_line', 'test', 'queued', $1, $1) RETURNING id`, [at]), 7);
        assert.strictEqual(await db.value(`INSERT INTO tip_goal_contributions (goal_id, interaction_id, amount, created_at, updated_at)
            VALUES ('tgoal_01', 'tint_03', 5, $1, $1) RETURNING id`, [at]), 13);
        assert.strictEqual(await db.value("INSERT INTO tips_event_outbox (event_id, envelope, created_at) VALUES ('evt_03', '{}', 1) RETURNING id"), 3);
    });

    await check('a rehearsal can be repeated (truncate), and a value the checksum would miss is caught', async () => {
        const again = await importSqlite({ sqlite: file, db, truncate: true, tables: TABLES, log: quiet });
        assert.strictEqual(again.ok, true, JSON.stringify(again.problems));
        // Without the 'null' mapping, JSON null and SQL NULL differ: the verification says so.
        const bad = await importSqlite({ sqlite: file, db, truncate: true, tables: { ...TABLES, paid_messages: {} }, only: ['paid_messages', 'tip_interactions', 'creator_tip_profiles'], log: quiet });
        assert.strictEqual(bad.ok, false);
        assert.match(bad.problems.map((x) => `${x.table}: ${x.problem}`).join('\n'), /paid_messages: verification failed/);
        await importSqlite({ sqlite: file, db, truncate: true, tables: TABLES, log: quiet });
    });

    await check('the service serves the imported data as it did from SQLite', async () => {
        const t = await boot({ db });
        const who = { subject: supporter, username: 'viewer' };
        const r = await t.call('GET', '/api/v1/interactions', { user: who });
        assert.strictEqual(r.status, 200, r.text);
        const byId = Object.fromEntries(r.json.interactions.map((i) => [i.id, i]));
        assert.deepStrictEqual(Object.keys(byId).sort(), ['tint_01', 'tint_02', 'tint_03']);
        assert.strictEqual(byId.tint_01.created_at, T('03T12:00:00.000'));
        assert.strictEqual(byId.tint_01.payment.settled_at, T('03T12:00:00.500'));
        assert.deepStrictEqual(byId.tint_02.payment.reversal_txn_ids, ['txn_9']);
        assert.strictEqual(byId.tint_02.public.supporter_name, 'Anonymous');
        const goal = (await t.call('GET', '/api/v1/goals/tgoal_01', { user: { subject: creator, username: 'alex' } })).json.goal;
        assert.strictEqual(goal.current_amount, 50 + 250 + 150, 'opening amount plus what the contributions keep');
        const replay = await t.call('POST', '/api/v1/checkout', { user: who, key: 'tip-key-0001', body: {} });
        assert.strictEqual(replay.status, 422, 'a different request under a stored key is refused');
        assert.strictEqual(await t.db.value('SELECT count(*) FROM tips_event_inbox'), 1);
        await t.close();
    });

    await check('scripts/migrate-to-postgres.js: OK exits 0; a column the schema lacks is a problem and exits 1', async () => {
        const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate-to-postgres.js'), '--pglite', '--sqlite', file], { encoding: 'utf8' });
        assert.match(out, /→ pglite \(\d+ ms\): OK/);
        assert.match(out, /tips_event_outbox\s+2 rows\s+[0-9a-f]{16}\s+\(from event_outbox\)/);
        assert.match(out, /cleaned: tip_interactions\.message: 1 value\(s\) with a NUL or an unpaired surrogate/);
        const extra = path.join(tmp, 'extra.db');
        fs.copyFileSync(file, extra);
        const s = new Database(extra); s.exec('ALTER TABLE tip_goals ADD COLUMN mystery TEXT'); s.close();
        let code = 0; let text = '';
        try { execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate-to-postgres.js'), '--pglite', '--sqlite', extra], { encoding: 'utf8' }); } catch (e) { code = e.status; text = e.stdout; }
        assert.strictEqual(code, 1);
        assert.match(text, /problem: tip_goals: source columns with no target column .*mystery/);
    });

    await imported.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    done();
})().catch((e) => { console.error(e); process.exit(1); });
