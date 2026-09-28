#!/usr/bin/env node
'use strict';
/**
 * The one-time move of Tips' SQLite database into its PostgreSQL schema (ADR-035; the procedure is
 * openvibe-sdk docs/migrating-to-postgresql.md, section 6).
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json]
 *
 *   1. applies migrations/ as the owner (DATABASE_DIRECT_URL, a direct connection);
 *   2. copies every table with openvibe-sdk's importSqlite (batched, parents first, identities kept and
 *      their sequences advanced) into emptied tables (truncate: a rehearsal can be repeated);
 *   3. verifies each table's row count and a checksum of every row on both sides, prints the report,
 *      and exits 1 unless report.ok.
 *
 * The SQLite file (TIPS_DB_PATH, config.sqlitePath; --sqlite for a copy) is opened read-only: nothing in
 * it changes. --pglite imports into an in-memory PostgreSQL instead (a rehearsal with nothing to set up;
 * the report is all it leaves). --json prints the whole report.
 *
 * In production it runs once, from the new release's directory, as the service user with the service's
 * environment, while the service is stopped (the write freeze), before the PostgreSQL release starts.
 *
 * What does not map one to one:
 *   settings                 not carried: the SQLite bookkeeping row (schema_version 3); ov_migrations
 *                            records the schema now (migrations/0001_initial.sql)
 *   event_outbox             → tips_event_outbox (the SDK outbox, outboxSchema('tips_event_outbox'))
 *   idempotency_receipts     → tips_event_inbox (the SDK inbox, inboxSchema('tips_event_inbox'))
 *   JSON text 'null'         → SQL NULL in the reference columns (interaction_effects.result,
 *                            paid_messages.chat_ref, paid_media_requests.queue_ref): the SQLite code
 *                            wrote JSON.stringify(null) when an adapter returned no reference, the
 *                            PostgreSQL code writes NULL, and both mean "no reference"
 *   NUL, unpaired surrogate  PostgreSQL stores no NUL character in text or jsonb and no unpaired surrogate
 *                            in jsonb (SQLite took both; the code strips them now): a NUL is dropped and an
 *                            unpaired surrogate becomes U+FFFD, in text and inside JSON values alike. The
 *                            report lists every column where that happened and how many values changed
 * No column is dropped.
 */
const path = require('path');
const { createDb, importSqlite } = require('openvibe-sdk/db');
const { loadConfig } = require('../server/config');
const { migrate, MIGRATIONS } = require('../server/db');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

/** A row map turning the JSON text 'null' into SQL NULL for these columns. */
const jsonNullToSql = (...cols) => (row) => {
    for (const c of cols) if (row[c] === 'null') row[c] = null;
    return row;
};

const TABLES = {
    tips_event_outbox: { from: 'event_outbox' },
    tips_event_inbox: { from: 'idempotency_receipts' },
    interaction_effects: { map: jsonNullToSql('result') },
    paid_messages: { map: jsonNullToSql('chat_ref') },
    paid_media_requests: { map: jsonNullToSql('queue_ref') },
};

const cleanText = (v) => v.toWellFormed().replace(/\u0000/g, '');
function cleanJson(v) {
    if (typeof v === 'string') return cleanText(v);
    if (Array.isArray(v)) return v.map(cleanJson);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanText(k), cleanJson(x)]));
    return v;
}

/**
 * importSqlite's `tables` for this schema: TABLES, and for every table a map that makes its text and
 * JSON values storable (see above). `cleaned` counts the distinct values changed per column (the
 * verification sees the same mapped values on both sides, so this is the record of what changed).
 */
async function importOptions(db) {
    const cols = await db.many(`SELECT table_name, column_name, udt_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name <> 'ov_migrations' AND udt_name IN ('text', 'varchar', 'json', 'jsonb')`);
    const byTable = new Map();
    for (const c of cols) { if (!byTable.has(c.table_name)) byTable.set(c.table_name, []); byTable.get(c.table_name).push(c); }
    const cleaned = new Map();   // "table.column" → Set of the original values changed
    const note = (t, c, v) => { const k = `${t}.${c}`; if (!cleaned.has(k)) cleaned.set(k, new Set()); cleaned.get(k).add(v); };
    const tables = {};
    for (const [table, list] of byTable) {
        const base = TABLES[table] || {};
        tables[table] = {
            ...base,
            map(row) {
                const r = base.map ? base.map(row) : row;
                if (!r) return r;
                for (const { column_name: c, udt_name: udt } of list) {
                    const v = r[c];
                    if (typeof v !== 'string') continue;
                    if (udt === 'json' || udt === 'jsonb') {
                        let parsed;
                        try { parsed = JSON.parse(v); } catch { continue; }   // left for the importer to report
                        const fixed = JSON.stringify(cleanJson(parsed));
                        if (fixed !== JSON.stringify(parsed)) { note(table, c, v); r[c] = fixed; }
                    } else {
                        const fixed = cleanText(v);
                        if (fixed !== v) { note(table, c, v); r[c] = fixed; }
                    }
                }
                return r;
            },
        };
    }
    return { tables, cleaned: () => [...cleaned].map(([column, values]) => ({ column, values: values.size })) };
}

async function main() {
    const config = loadConfig();
    const sqlite = path.resolve(opt('sqlite') || config.sqlitePath);
    const quiet = { log() {}, warn: console.warn, error: console.error };
    let owner;
    if (flag('pglite')) {
        owner = createDb({ pglite: true, service: 'tips-import' });
        await owner.migrate({ dir: MIGRATIONS, log: quiet });
    } else {
        await migrate(config, { log: quiet });
        owner = createDb({ url: config.db.directUrl, service: 'tips-import', max: 2 });
    }
    try {
        const t0 = Date.now();
        const options = await importOptions(owner);
        const report = await importSqlite({ sqlite, db: owner, truncate: true, tables: options.tables, log: quiet });
        const cleaned = options.cleaned();
        if (flag('json')) console.log(JSON.stringify({ sqlite, into: owner.store, ...report, cleaned }, null, 2));
        else {
            console.log(`import ${sqlite} → ${owner.store} (${Date.now() - t0} ms): ${report.ok ? 'OK' : 'PROBLEMS'}`);
            for (const t of report.tables) console.log(`  ${t.table.padEnd(24)} ${String(t.rows).padStart(8)} rows  ${t.checksum || '-'}${t.source !== t.table ? `  (from ${t.source})` : ''}`);
            for (const c of cleaned) console.log(`  cleaned: ${c.column}: ${c.values} value(s) with a NUL or an unpaired surrogate`);
            for (const p of report.problems) console.log(`  problem: ${p.table}: ${p.problem}`);
        }
        return report.ok ? 0 : 1;
    } finally {
        await owner.close();
    }
}

if (require.main === module) {
    main().then((code) => process.exit(code), (e) => { console.error(`migrate-to-postgres failed: ${e.message}`); process.exit(1); });
}

module.exports = { TABLES, importOptions };
