'use strict';
/**
 * A migrated database for one test run (ADR-035).
 *
 *   store 'pglite' (the default): real PostgreSQL in-process, migrated (openvibe-sdk/db { pglite }).
 *   store 'pg': the production-shaped containers (openvibe-sdk scripts/test-services.sh up), when
 *     OV_TEST_PG_URL (PgBouncer, transaction mode) and OV_TEST_PG_DIRECT_URL are set. The run gets roles
 *     and a schema of its own, shaped as OpenVibe.Host's roles/data/add-service.sh makes them: an owner
 *     role that migrates on the direct connection, and a runtime role (DML only, statement_timeout 15 s,
 *     lock_timeout 5 s) that serves through PgBouncer. Other suites sharing the database never see them;
 *     close() drops them.
 *
 *   TIPS_TEST_STORE=pg runs every test file on the containers instead of PGlite.
 *
 *   const { db, close } = await testDb();
 *   testValkey()   the containers' Valkey (OV_TEST_VALKEY_URL) under a prefix of its own, or null
 */
const crypto = require('crypto');
const { createDb } = require('openvibe-sdk/db');
const { createValkey } = require('openvibe-sdk/valkey');
const { MIGRATIONS } = require('../../server/db');

const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const pgAvailable = () => !!(process.env.OV_TEST_PG_URL && process.env.OV_TEST_PG_DIRECT_URL);
const valkeyAvailable = () => !!process.env.OV_TEST_VALKEY_URL;

async function testDb({ store = process.env.TIPS_TEST_STORE || 'pglite', max = 4 } = {}) {
    if (store !== 'pg') {
        const db = createDb({ pglite: true, service: 'tips-test', log: quiet });
        // windowDays 0: a test wants the final schema, not a contract held for its N-1 window.
        await db.migrate({ dir: MIGRATIONS, log: quiet, windowDays: 0 });
        return { db, store: 'pglite', close: () => db.close().catch(() => {}) };
    }
    if (!pgAvailable()) throw new Error('store pg needs OV_TEST_PG_URL and OV_TEST_PG_DIRECT_URL (openvibe-sdk scripts/test-services.sh up)');
    const name = `tips_t${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
    const owner = `${name}_owner`;
    const pw = crypto.randomBytes(16).toString('hex');
    const su = createDb({ url: process.env.OV_TEST_PG_DIRECT_URL, service: 'tips-test-admin', max: 1, log: quiet });
    const database = await su.value('SELECT current_database()');
    for (const stmt of [
        `CREATE ROLE ${owner} LOGIN PASSWORD '${pw}'`,
        `CREATE ROLE ${name} LOGIN PASSWORD '${pw}'`,
        `GRANT CONNECT ON DATABASE ${database} TO ${owner}, ${name}`,
        `CREATE SCHEMA ${name} AUTHORIZATION ${owner}`,
        `ALTER ROLE ${owner} SET search_path = ${name}`,
        `ALTER ROLE ${name} SET search_path = ${name}`,
        `ALTER ROLE ${name} SET statement_timeout = '15s'`,
        `ALTER ROLE ${name} SET lock_timeout = '5s'`,
        `GRANT USAGE ON SCHEMA ${name} TO ${name}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${name} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${name} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${name}`,
    ]) await su.query(stmt);
    const as = (url, user) => { const u = new URL(url); u.username = user; u.password = pw; return u.toString(); };
    async function drop() {
        try {
            // PgBouncer keeps its server connections after the client pool closes: end them here, or
            // every run would leave its roles' idle connections holding the server's slots.
            await su.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1)', [[name, owner]]);
            await su.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            for (const r of [name, owner]) { await su.query(`DROP OWNED BY ${r}`); await su.query(`DROP ROLE ${r}`); }
        } finally { await su.close(); }
    }
    let db;
    try {
        const ownerDb = createDb({ url: as(process.env.OV_TEST_PG_DIRECT_URL, owner), service: 'tips-test-migrate', max: 1, log: quiet });
        try { await ownerDb.migrate({ dir: MIGRATIONS, log: quiet, windowDays: 0 }); } finally { await ownerDb.close(); }
        db = createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: 'tips-test', max, log: quiet });
    } catch (e) { await drop().catch(() => {}); throw e; }   // a failed setup leaves nothing behind
    return {
        db, store: 'postgresql', schema: name,
        /** Another pooled handle on the same database (a second process). */
        open: (o = {}) => createDb({ url: as(process.env.OV_TEST_PG_URL, name), service: 'tips-test', max, log: quiet, ...o }),
        async close() {
            await db.close().catch(() => {});
            await drop();
        },
    };
}

/** The containers' Valkey under a prefix no other run uses (ov:tips-test:<random>:), or null without it. */
function testValkey() {
    if (!valkeyAvailable()) return null;
    return createValkey({ url: process.env.OV_TEST_VALKEY_URL, prefix: `ov:tips-test:${crypto.randomBytes(4).toString('hex')}:`, log: quiet });
}

module.exports = { testDb, testValkey, pgAvailable, valkeyAvailable };
