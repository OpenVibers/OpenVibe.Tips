#!/usr/bin/env node
'use strict';
/**
 * Import OpenVibe.Live's tip history into Tips, linked to OpenVibe.Billing's imported journal.
 *
 *   node scripts/import-live.js --live-db <live snapshot> [--billing-db <billing snapshot>] [--dry-run] [--json]
 *
 * Both databases must be COPIES (e.g. `sqlite3 live.db ".backup live-snapshot.db"`); they are opened
 * read-only. Run it AFTER Billing's own import (scripts/import-live.js in OpenVibe.Billing) so every
 * Live donation links to its Billing transaction. Live user ids are resolved to Network subjects
 * through resolve-batch with Tips' client credentials (capability identity.subject.resolve).
 *
 * With --billing-db the report ends with the reconciliation: per creator, Tips' settled total must
 * equal Billing's; the exit code is 1 when it does not. Safe to re-run.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createIdentity } = require('../server/network');
const { createTipsOutbox } = require('../server/events/outbox');
const { createDomain } = require('../server/domain');
const { importLive, billingSnapshotSource } = require('../server/importer/live');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

async function main() {
    const livePath = opt('live-db');
    if (!livePath) { console.error('usage: import-live.js --live-db <snapshot> [--billing-db <snapshot>] [--dry-run] [--json]'); process.exit(2); }
    const config = loadConfig();
    for (const p of [livePath, opt('billing-db')].filter(Boolean)) if (path.resolve(p) === path.resolve(config.dbPath)) throw new Error(`${p} is the Tips database`);
    const live = new Database(livePath, { readonly: true, fileMustExist: true });
    const bdb = opt('billing-db') ? new Database(opt('billing-db'), { readonly: true, fileMustExist: true }) : null;
    const db = openDb(config.dbPath);
    const outbox = createTipsOutbox({ db, config });
    const domain = createDomain({ db, config, outbox, billing: null, adapters: {}, log: console });
    const identity = createIdentity(config);
    const report = await importLive(domain, { live, billingSource: bdb ? billingSnapshotSource(bdb) : null, resolveLiveUsers: identity.resolveLiveUsers, dryRun: flag('dry-run') });
    if (flag('json')) console.log(JSON.stringify(report, null, 2));
    else {
        const c = report.counts;
        console.log(`import ${report.run_id}${report.dry_run ? ' (DRY RUN — nothing kept)' : ''}`);
        console.log(`  live snapshot: ${JSON.stringify(c.live)}; identities ${JSON.stringify(c.identities)}; test before ${report.test_before || '(none)'}`);
        console.log(`  imported ${c.imported} tips (${c.linked_to_billing} linked to Billing, ${c.unlinked} not), ${c.refunds_applied} refunds applied, ${c.external} external PowerChat tips, ${c.goals} goals`);
        console.log(`  held ${c.held}, excluded ${c.excluded}, unchanged ${c.unchanged}, released from hold ${c.released}`);
        for (const h of report.holds) console.log(`    held: ${JSON.stringify(h)}`);
        const r = report.reconciliation;
        if (!r) console.log('  reconciliation: skipped (no --billing-db)');
        else {
            console.log(`  reconciliation: ${r.ok ? 'OK' : 'MISMATCH'} over ${r.creators} creators`);
            for (const m of r.mismatches) console.log(`    ${m.creator}: tips ${m.tips} vs billing ${m.billing} (difference ${m.difference})`);
        }
    }
    live.close();
    if (bdb) bdb.close();
    db.close();
    if (report.reconciliation && !report.reconciliation.ok) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
