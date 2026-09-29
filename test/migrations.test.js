'use strict';
// migrations/ (ADR-035, ADR-028): the files parse with their phase, apply in order, and apply again
// without change; a contract migration drops what an earlier expand left behind; and every query shape
// the code runs can be served by an index.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createDb, sql } = require('openvibe-sdk/db');
const { MIGRATIONS } = require('../server/db');
const { check, done } = require('./helpers/app');

const quiet = { log() {} };

/** The migration files as the SDK reads them: NNNN_name.sql with a phase header (and after: for a contract). */
function parse(dir) {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((file) => {
        const m = /^(\d{4,})_([a-z0-9_-]+)\.sql$/.exec(file);
        assert.ok(m, `${file} is named NNNN_description.sql`);
        const head = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').slice(0, 12).join('\n');
        const phase = (/^--\s*phase:\s*(expand|migrate|contract)\s*$/m.exec(head) || [])[1];
        assert.ok(phase, `${file} has a phase header`);
        return { id: m[1], name: m[2], file, phase, after: (/^--\s*after:\s*(\d{4,})\s*$/m.exec(head) || [])[1] || null, transaction: !/^--\s*no-transaction\s*$/m.test(head) };
    });
}

(async () => {
    const db = createDb({ pglite: true, service: 'tips-test', log: { warn() {}, error: console.error } });

    await check('the files parse: numbered, each with its phase; 0001 is the initial expand', async () => {
        const files = parse(MIGRATIONS);
        assert.ok(files.length >= 1);
        assert.deepStrictEqual([files[0].id, files[0].name, files[0].phase, files[0].transaction], ['0001', 'initial', 'expand', true]);
        assert.deepStrictEqual(files.map((f) => f.id), [...files.map((f) => f.id)].sort(), 'applied in order');
        for (const f of files) if (f.phase === 'contract') assert.ok(f.after, `${f.file} names its expand`);
    });

    await check('they apply once, in order, and a second run changes nothing', async () => {
        const first = await db.migrate({ dir: MIGRATIONS, log: quiet, windowDays: 0 });
        assert.deepStrictEqual(first.applied.map((m) => m.id), parse(MIGRATIONS).map((m) => m.id));
        const schema = async () => db.many(sql`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
            WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
        const before = await schema();
        const second = await db.migrate({ dir: MIGRATIONS, log: quiet, windowDays: 0 });
        assert.deepStrictEqual([second.applied, second.held], [[], []]);
        assert.deepStrictEqual(await schema(), before, 'the schema is the same after a second run');
        assert.strictEqual(await db.value(sql`SELECT count(*) FROM ov_migrations`), parse(MIGRATIONS).length);
    });

    await check('the contract migration drops the legacy import columns and the map table', async () => {
        assert.deepStrictEqual(await db.many(sql`SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'legacy_source'`), []);
        assert.deepStrictEqual(await db.many(sql`SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'migration_maps'`), []);
    });

    await check('every table has a primary key; money and time columns have their types', async () => {
        const noKey = await db.many(sql`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary)`);
        assert.deepStrictEqual(noKey, []);
        const type = async (t, c) => db.value(sql`SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${t} AND column_name = ${c}`);
        for (const [t, c] of [['tip_interactions', 'amount'], ['tip_interactions', 'reversed_bits'], ['tip_goals', 'target_amount'], ['tip_goal_contributions', 'amount'], ['tip_interactions', 'next_transfer_at'], ['interaction_effects', 'next_attempt_at']]) {
            assert.strictEqual(await type(t, c), 'bigint', `${t}.${c}`);
        }
        for (const [t, c] of [['tip_interactions', 'created_at'], ['tip_interactions', 'settled_at'], ['overlay_deliveries', 'created_at'], ['api_idempotency', 'created_at']]) {
            assert.strictEqual(await type(t, c), 'timestamp with time zone', `${t}.${c}`);
        }
        for (const [t, c] of [['tip_interactions', 'test'], ['tip_interactions', 'transfer_due'], ['creator_tip_profiles', 'page_enabled'], ['overlay_deliveries', 'hidden']]) {
            assert.strictEqual(await type(t, c), 'boolean', `${t}.${c}`);
        }
        for (const [t, c] of [['tip_interactions', 'request'], ['overlay_deliveries', 'payload'], ['tips_event_outbox', 'envelope'], ['overlay_tokens', 'scopes']]) {
            assert.strictEqual(await type(t, c), 'jsonb', `${t}.${c}`);
        }
        assert.strictEqual(await type('api_idempotency', 'response'), 'text', 'replayed byte for byte');
    });

    await check('every query shape the code runs can be served by an index (no sequential scan of its table)', async () => {
        // With sequential scans switched off for the plan, a shape that has no usable index still plans a
        // Seq Scan (at a prohibitive cost): that is what this looks for.
        const shapes = {
            'interactions of a creator, a keyset page': ['tip_interactions', sql`SELECT * FROM tip_interactions WHERE creator_subject = 'c' AND (created_at, id) < (now(), 'x') ORDER BY created_at DESC, id DESC LIMIT 51`],
            'receipts of a supporter, a keyset page': ['tip_interactions', sql`SELECT * FROM tip_interactions WHERE supporter_subject = 's' AND NOT test ORDER BY created_at DESC, id DESC LIMIT 51`],
            'the moderation queue by state': ['tip_interactions', sql`SELECT * FROM tip_interactions WHERE creator_subject = 'c' AND payment_state IN ('settled', 'reversed', 'pending') AND moderation = 'held' ORDER BY created_at DESC, id DESC LIMIT 51`],
            'unpaid checkouts of a supporter': ['tip_interactions', sql`SELECT count(*) FROM tip_interactions WHERE supporter_subject = 's' AND funding = 'checkout' AND payment_state = 'pending' AND created_at >= now()`],
            'due transfers (the lease claim)': ['tip_interactions', sql`SELECT id FROM tip_interactions WHERE payment_state = 'pending' AND transfer_due AND next_transfer_at <= 5 ORDER BY next_transfer_at LIMIT 10 FOR UPDATE SKIP LOCKED`],
            'the supporters leaderboard': ['tip_interactions', sql`SELECT supporter_subject, SUM(amount - reversed_bits) FROM tip_interactions WHERE creator_subject = 'c' AND supporter_subject IS NOT NULL AND NOT test
                AND payment_state IN ('settled', 'reversed') AND NOT anonymous AND NOT hide_amount AND erased_at IS NULL AND moderation = 'visible' GROUP BY supporter_subject`],
            'recent public messages': ['tip_interactions', sql`SELECT * FROM tip_interactions WHERE creator_subject = 'c' AND payment_state = 'settled' AND message IS NOT NULL AND NOT test ORDER BY settled_at DESC, id DESC LIMIT 20`],
            'an interaction by Billing transaction': ['tip_interactions', sql`SELECT * FROM tip_interactions WHERE billing_txn_id = 't'`],
            'an interaction by checkout intent': ['tip_interactions', sql`SELECT * FROM tip_interactions WHERE billing_intent_id = 'i'`],
            'an interaction by provider reference': ['tip_interactions', sql`SELECT 1 FROM tip_interactions WHERE provider = 'powerchat' AND provider_ref = 'r'`],
            'goals of a creator': ['tip_goals', sql`SELECT * FROM tip_goals WHERE creator_subject = 'c' AND status = 'active' ORDER BY sort_order, created_at`],
            'goal totals': ['tip_goal_contributions', sql`SELECT goal_id, SUM(amount - reversed_amount) FROM tip_goal_contributions WHERE goal_id = ANY('{a,b}'::text[]) GROUP BY goal_id`],
            'the latest supporters of a goal': ['tip_goal_contributions', sql`SELECT * FROM tip_goal_contributions WHERE goal_id = 'g' ORDER BY id DESC LIMIT 10`],
            'the contributions of an interaction': ['tip_goal_contributions', sql`SELECT * FROM tip_goal_contributions WHERE interaction_id = 'i'`],
            'due effects (the lease claim)': ['interaction_effects', sql`SELECT id FROM interaction_effects WHERE state = 'queued' AND next_attempt_at <= 5 ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`],
            'the effects of a page of interactions': ['interaction_effects', sql`SELECT * FROM interaction_effects WHERE interaction_id = ANY('{a,b}'::text[]) ORDER BY interaction_id, id`],
            'an overlay stream after a seq': ['overlay_deliveries', sql`SELECT * FROM overlay_deliveries WHERE creator_subject = 'c' AND seq > 5 AND status <> 'failed' AND NOT hidden ORDER BY seq LIMIT 200`],
            'the delivery window sweep': ['overlay_deliveries', sql`SELECT seq FROM overlay_deliveries WHERE status = 'pending' AND NOT hidden AND created_at < now() ORDER BY seq LIMIT 500`],
            'the deliveries of an interaction': ['overlay_deliveries', sql`SELECT * FROM overlay_deliveries WHERE interaction_id = 'i'`],
            'overlay tokens of a creator': ['overlay_tokens', sql`SELECT * FROM overlay_tokens WHERE creator_subject = 'c' ORDER BY revoked_at IS NOT NULL, created_at DESC`],
            'an overlay token by its secret': ['overlay_tokens', sql`SELECT * FROM overlay_tokens WHERE token_hash = 'h'`],
            'overlay configs of a creator': ['overlay_configs', sql`SELECT * FROM overlay_configs WHERE creator_subject = 'c' ORDER BY created_at`],
            'a creator by handle': ['creator_tip_profiles', sql`SELECT * FROM creator_tip_profiles WHERE handle = 'h'`],
            'switched-on pages (home, sitemap)': ['creator_tip_profiles', sql`SELECT handle FROM creator_tip_profiles WHERE page_enabled ORDER BY updated_at DESC LIMIT 24`],
            'the creators a person moderates': ['tip_moderators', sql`SELECT * FROM tip_moderators WHERE moderator_subject = 's' AND removed_at IS NULL`],
            'open invitations of a creator': ['tip_moderator_invites', sql`SELECT * FROM tip_moderator_invites WHERE creator_subject = 'c' AND used_at IS NULL ORDER BY created_at`],
            'the moderation log of a creator': ['tip_moderation_log', sql`SELECT * FROM tip_moderation_log WHERE creator_subject = 'c' ORDER BY id DESC LIMIT 100`],
            'the weekly prune of stored answers': ['api_idempotency', sql`DELETE FROM api_idempotency WHERE created_at < now()`],
            'an erasure scrubbing outbox copies': ['tips_event_outbox', sql`SELECT id FROM tips_event_outbox WHERE envelope->'subject'->>'type' = 'interaction' AND envelope->'subject'->>'id' = ANY('{a}'::text[])`],
            'the rejected-events count': ['tips_event_outbox', sql`SELECT count(*) FROM tips_event_outbox WHERE rejected_at IS NOT NULL`],
        };
        const scans = [];
        for (const [name, [table, q]] of Object.entries(shapes)) {
            const plan = await db.tx(async (t) => {
                await t.query('SET LOCAL enable_seqscan = off');
                return t.value(sql`EXPLAIN (FORMAT JSON) ${q}`);
            });
            const nodes = [];
            const walk = (n) => { nodes.push(n); (n.Plans || []).forEach(walk); };
            walk(plan[0].Plan);
            if (nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table)) scans.push(name);
        }
        assert.deepStrictEqual(scans, []);
    });

    await db.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
