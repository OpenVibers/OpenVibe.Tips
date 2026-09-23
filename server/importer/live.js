'use strict';

/**
 * Import tip history from a SNAPSHOT COPY of OpenVibe.Live's database (opened read-only), linked to
 * OpenVibe.Billing's imported journal, with a reconciliation report.
 *
 *   1. identities   every Live user id in a tip row → Network subject (resolve-batch). A tip whose
 *                   CREATOR has no subject is held (migration_maps status 'held'), never dropped; a
 *                   later run imports it once the Network knows the creator. An unmapped supporter is
 *                   imported with no subject and their Live username as the display name.
 *   2. donations    transactions (type 'donation') → tip_interactions, settlement 'imported':
 *                   completed → payment settled; anything else → excluded with the reason (no balance
 *                   moved on Live). Rows before site_settings.stats_vibes_reset_at are imported flagged
 *                   test, exactly as Billing flags them. Media-request charges ("Media request: …")
 *                   become kind media_request. Each row is linked to Billing's transaction for it
 *                   (Billing's importer key `import:live:txn:<live id>`).
 *   3. refunds      transactions (type 'refund', streamer → donor) are applied to the latest earlier
 *                   donation from that donor to that streamer that still has room (reversed_bits), so a
 *                   creator's total nets them out the way Billing's journal does; none left → held.
 *   4. external     chat_messages of kind donation with source powerchat — the only record Live kept of
 *                   tips on a streamer's OWN PowerChat (EXTERNAL, no Billing liability). A message that
 *                   matches a site-routed "PowerChat tip via site account" donation row (same streamer,
 *                   same amount, within 10 minutes) is that row's celebration and is excluded, not
 *                   counted twice.
 *   5. goals        donation_goals → tip_goals (Live's current_amount carried over as opening_amount:
 *                   Live never recorded which donations counted toward which goal).
 *
 * Reconciliation: per creator subject, Tips' settled-via-Billing total (non-test, minus refunds) must
 * equal Billing's (donations to the creator minus refunds from them, non-test). Any difference is
 * listed; nothing is absorbed.
 *
 * Idempotent: every row is keyed by legacy_source / migration_maps (live, table, id); a re-run changes
 * nothing, and a later snapshot only adds what is new or releases what was held. --dry-run does it all
 * inside a transaction that is rolled back.
 */
const { iso, prefixedId, json } = require('../util');

const liveTs = (s) => {
    if (!s) return null;
    const str = String(s);
    const t = Date.parse(str.includes('T') ? str : `${str.replace(' ', 'T')}Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columns = (db, t) => (tableExists(db, t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);

class DryRun extends Error {}

/**
 * Billing's side, from a read-only SNAPSHOT of billing.db (operator tool, like Billing reading Live's
 * snapshot): the transaction Billing's importer made for each Live row, and per-creator totals.
 */
function billingSnapshotSource(bdb) {
    const byKey = bdb.prepare("SELECT id, test FROM transactions WHERE idempotency_key = ?");
    return {
        name: 'billing snapshot',
        linkLiveTxn(liveId) { const r = byKey.get(`import:live:txn:${liveId}`); return r ? r.id : null; },
        creatorTotals() {
            const totals = new Map();
            const add = (s, n) => { if (s && n) totals.set(s, (totals.get(s) || 0) + n); };
            const rows = bdb.prepare('SELECT id, type, status, from_subject, to_subject, reverses_txn, metadata FROM transactions WHERE test = 0').all();
            const donations = new Set(rows.filter((t) => t.type === 'donation').map((t) => t.id));
            for (const t of rows) {
                const m = json(t.metadata, {});
                if (t.type === 'import' && m.live && m.live.status === 'completed' && !m.note) {
                    // Billing's replay of Live's history: donation → the creator's payable; refund → out of it.
                    if (m.live.type === 'donation') add(t.to_subject, Number(m.live.amount) || 0);
                    if (m.live.type === 'refund') add(t.from_subject, -(Number(m.live.amount) || 0));
                } else if (t.type === 'donation') {
                    add(t.to_subject, Number(m.amount_bits) || 0);
                } else if (t.type === 'refund' && donations.has(t.reverses_txn) && m.amount_bits != null) {
                    // A credit-funded transfer given back (the creator's payable → the giver's credit).
                    add(t.from_subject, -(Number(m.amount_bits) || 0));
                }
            }
            return totals;
        },
    };
}

async function importLive(domain, { live, billingSource = null, resolveLiveUsers, dryRun = false, log = console }) {
    const { db } = domain;
    const started = domain.now();
    const runId = prefixedId('timp', started);
    const at = iso(started);
    const report = {
        run_id: runId, dry_run: !!dryRun, started_at: at, source: 'openvibe-live snapshot', billing_source: billingSource ? billingSource.name : null,
        counts: { imported: 0, held: 0, excluded: 0, refunds_applied: 0, external: 0, goals: 0, unchanged: 0, released: 0, linked_to_billing: 0, unlinked: 0 },
        holds: [], excluded: [], unlinked: [], reconciliation: null,
    };

    // ── Read the snapshot ────────────────────────────────────
    const txns = tableExists(live, 'transactions') ? live.prepare("SELECT * FROM transactions WHERE type IN ('donation', 'refund') ORDER BY id").all() : [];
    const chatCols = columns(live, 'chat_messages');
    // Live's chat_messages carries its time in `timestamp` (older snapshots: created_at).
    const chatTs = chatCols.includes('created_at') ? 'created_at' : (chatCols.includes('timestamp') ? 'timestamp' : 'NULL');
    const chatDonations = chatCols.includes('metadata')
        ? live.prepare(`SELECT id, channel_user_id, username, message, metadata, ${chatTs} AS created_at FROM chat_messages WHERE message_type = 'donation' AND metadata LIKE '%powerchat%' ORDER BY id`).all()
        : [];
    const goalRows = tableExists(live, 'donation_goals') ? live.prepare('SELECT * FROM donation_goals ORDER BY id').all() : [];
    const users = new Map((tableExists(live, 'users') ? live.prepare('SELECT id, username, display_name FROM users').all() : []).map((u) => [String(u.id), u]));
    let resetAt = null;
    if (tableExists(live, 'site_settings')) {
        const r = live.prepare("SELECT value FROM site_settings WHERE key = 'stats_vibes_reset_at'").get();
        if (r && r.value && !Number.isNaN(Date.parse(r.value))) resetAt = new Date(r.value).toISOString();
    }
    report.test_before = resetAt;
    report.counts.live = { tip_transactions: txns.length, powerchat_chat_donations: chatDonations.length, goals: goalRows.length };

    // ── 1. identities ────────────────────────────────────────
    const ids = new Set();
    for (const t of txns) { if (t.from_user_id) ids.add(String(t.from_user_id)); if (t.to_user_id) ids.add(String(t.to_user_id)); }
    for (const c of chatDonations) if (c.channel_user_id) ids.add(String(c.channel_user_id));
    for (const g of goalRows) if (g.user_id) ids.add(String(g.user_id));
    const map = ids.size ? await resolveLiveUsers([...ids]) : new Map();
    const subjectOf = (liveId) => { const v = liveId == null ? null : map.get(String(liveId)); return v ? (typeof v === 'string' ? v : v.subject) : null; };
    const nameOf = (liveId) => { const u = users.get(String(liveId)); return u ? (u.display_name || u.username) : null; };
    report.counts.identities = { resolved: [...ids].filter((i) => subjectOf(i)).length, unmapped: [...ids].filter((i) => !subjectOf(i)).length };

    const mapRow = db.prepare('SELECT * FROM migration_maps WHERE source = ? AND source_table = ? AND source_id = ?');
    const upsertMap = db.prepare(`INSERT INTO migration_maps (source, source_table, source_id, target_type, target_id, status, reason, billing_txn_id, run_id, created_at, updated_at)
        VALUES ('live', @table, @id, @target_type, @target_id, @status, @reason, @billing, @run, @at, @at)
        ON CONFLICT (source, source_table, source_id) DO UPDATE SET target_type = excluded.target_type, target_id = excluded.target_id, status = excluded.status,
            reason = excluded.reason, billing_txn_id = COALESCE(excluded.billing_txn_id, migration_maps.billing_txn_id), run_id = excluded.run_id, updated_at = excluded.updated_at`);
    const record = (table, id, fields) => upsertMap.run({ table, id: String(id), target_type: null, target_id: null, reason: null, billing: null, run: runId, at, ...fields });

    const run = () => {
        // ── 2. donations ─────────────────────────────────────
        for (const t of txns.filter((x) => x.type === 'donation')) {
            const prev = mapRow.get('live', 'transactions', String(t.id));
            if (prev && prev.status !== 'held') {
                // Re-link to Billing when an earlier run had no Billing transaction for it yet.
                if (prev.status === 'imported' && !prev.billing_txn_id && billingSource) {
                    const b = billingSource.linkLiveTxn(t.id);
                    if (b) { db.prepare('UPDATE tip_interactions SET billing_txn_id = ? WHERE id = ? AND billing_txn_id IS NULL').run(b, prev.target_id); record('transactions', t.id, { ...pick(prev), billing: b }); report.counts.linked_to_billing++; }
                }
                report.counts.unchanged++;
                continue;
            }
            const amount = Math.round(Number(t.amount) || 0);
            const creator = subjectOf(t.to_user_id);
            if (t.status !== 'completed' || amount <= 0) {
                const reason = amount <= 0 ? 'non-positive amount' : `status ${t.status}: no balance moved on Live`;
                record('transactions', t.id, { status: 'excluded', reason });
                report.counts.excluded++; report.excluded.push({ live_txn: t.id, reason });
                continue;
            }
            if (!creator) {
                const reason = `creator (Live user ${t.to_user_id}) has no Network subject yet`;
                record('transactions', t.id, { status: 'held', reason });
                report.counts.held++; report.holds.push({ live_txn: t.id, live_creator: t.to_user_id, amount });
                continue;
            }
            const created = liveTs(t.created_at) || at;
            const test = !!(resetAt && created < resetAt);
            const billingTxn = billingSource ? billingSource.linkLiveTxn(t.id) : null;
            const message = t.message ? String(t.message).slice(0, 500) : null;
            const media = /^Media request:/i.test(message || '');
            const site = /^PowerChat tip via site account/i.test(message || '');
            const i = domain.interactions.insert({
                id: prefixedId('tint', Date.parse(created)), creator_subject: creator, supporter_subject: subjectOf(t.from_user_id),
                supporter_name: nameOf(t.from_user_id) || (site ? 'PowerChat supporter' : null), kind: media ? 'media_request' : 'tip', amount,
                message: media || site ? null : message, request: { legacy_message: message, live_stream_id: t.stream_id || null },
                funding: site ? 'provider' : 'credit', settlement: 'imported', payment_state: 'settled', delivery_state: 'delivered',
                test: test ? 1 : 0, billing_txn_id: billingTxn, provider: site ? 'powerchat' : null, legacy_source: `live:transactions:${t.id}`,
                origin: 'import', created_at: created,
                target: t.stream_id ? { service: 'live', type: 'stream', id: String(t.stream_id) } : null,
            });
            db.prepare('UPDATE tip_interactions SET settled_at = ?, delivered_at = ? WHERE id = ?').run(created, created, i.id);
            record('transactions', t.id, { status: 'imported', target_type: 'interaction', target_id: i.id, billing: billingTxn, reason: prev ? 'released from hold' : null });
            if (prev) report.counts.released++;
            report.counts.imported++;
            if (billingTxn) report.counts.linked_to_billing++;
            else { report.counts.unlinked++; report.unlinked.push({ live_txn: t.id, interaction: i.id }); }
        }

        // ── 3. refunds (streamer → donor) ────────────────────
        for (const t of txns.filter((x) => x.type === 'refund')) {
            const prev = mapRow.get('live', 'transactions', String(t.id));
            if (prev && prev.status !== 'held') { report.counts.unchanged++; continue; }
            const amount = Math.round(Number(t.amount) || 0);
            if (t.status !== 'completed' || amount <= 0) { record('transactions', t.id, { status: 'excluded', reason: `refund with status ${t.status}` }); report.counts.excluded++; continue; }
            const creator = subjectOf(t.from_user_id);
            const donor = subjectOf(t.to_user_id);
            const created = liveTs(t.created_at) || at;
            const candidates = creator ? db.prepare(`SELECT * FROM tip_interactions WHERE creator_subject = ? AND settlement = 'imported' AND legacy_source LIKE 'live:transactions:%'
                    AND (supporter_subject IS ? ) AND created_at <= ? AND amount - reversed_bits > 0 ORDER BY created_at DESC`).all(creator, donor, created) : [];
            // Plan first; apply only when the whole refund can be placed.
            let left = amount;
            const plan = [];
            for (const c of candidates) {
                if (!left) break;
                const take = Math.min(left, c.amount - c.reversed_bits);
                plan.push({ c, take });
                left -= take;
            }
            if (left > 0) {
                record('transactions', t.id, { status: 'held', reason: `refund of ${amount} from Live user ${t.from_user_id} to ${t.to_user_id}: no earlier imported donation left to apply it to` });
                report.counts.held++; report.holds.push({ live_txn: t.id, refund: true, amount });
                continue;
            }
            const applied = [];
            for (const { c, take } of plan) {
                const ids = json(c.reversal_txn_ids, []); ids.push(`live:transactions:${t.id}`);
                db.prepare("UPDATE tip_interactions SET reversed_bits = reversed_bits + ?, payment_state = 'reversed', reversed_at = ?, reversal_txn_ids = ? WHERE id = ?").run(take, created, JSON.stringify(ids), c.id);
                applied.push({ interaction: c.id, bits: take });
            }
            record('transactions', t.id, { status: 'imported', target_type: 'refund', target_id: applied.map((a) => a.interaction).join(','), billing: billingSource ? billingSource.linkLiveTxn(t.id) : null });
            report.counts.refunds_applied++;
        }

        // ── 4. external PowerChat tips (chat record only) ────
        const siteRows = txns.filter((x) => x.type === 'donation' && /^PowerChat tip via site account/i.test(x.message || ''));
        const usedSite = new Set();
        for (const c of chatDonations) {
            const m = json(c.metadata, {});
            if (m.source !== 'powerchat' || m.kind !== 'donation') continue;
            const prev = mapRow.get('live', 'chat_messages', String(c.id));
            if (prev && prev.status !== 'held') { report.counts.unchanged++; continue; }
            const amount = Math.round(Number(m.amount) || 0);
            const created = liveTs(c.created_at) || at;
            const twin = siteRows.find((t) => !usedSite.has(t.id) && String(t.to_user_id) === String(c.channel_user_id) && Math.round(Number(t.amount)) === amount
                && Math.abs(Date.parse(liveTs(t.created_at) || at) - Date.parse(created)) <= 10 * 60 * 1000);
            if (twin) {
                usedSite.add(twin.id);
                record('chat_messages', c.id, { status: 'excluded', reason: `celebration of site-routed tip (Live transaction ${twin.id})` });
                report.counts.excluded++;
                continue;
            }
            if (amount <= 0) { record('chat_messages', c.id, { status: 'excluded', reason: 'no amount' }); report.counts.excluded++; continue; }
            const creator = subjectOf(c.channel_user_id);
            if (!creator) {
                record('chat_messages', c.id, { status: 'held', reason: `creator (Live user ${c.channel_user_id}) has no Network subject yet` });
                report.counts.held++; report.holds.push({ live_chat_message: c.id, live_creator: c.channel_user_id, amount });
                continue;
            }
            const i = domain.interactions.insert({
                id: prefixedId('tint', Date.parse(created)), creator_subject: creator, supporter_name: m.username ? String(m.username).slice(0, 80) : 'PowerChat supporter',
                kind: 'tip', amount, amount_cents: amount, message: m.message ? String(m.message).slice(0, 500) : null, funding: 'external', settlement: 'external',
                payment_state: 'settled', delivery_state: 'delivered', test: resetAt && created < resetAt ? 1 : 0, provider: 'powerchat',
                provider_ref: `live-chat:${c.id}`, legacy_source: `live:chat_messages:${c.id}`, origin: 'import', created_at: created,
            });
            db.prepare('UPDATE tip_interactions SET settled_at = ?, delivered_at = ? WHERE id = ?').run(created, created, i.id);
            record('chat_messages', c.id, { status: 'imported', target_type: 'interaction', target_id: i.id });
            report.counts.external++;
        }

        // ── 5. goals ─────────────────────────────────────────
        for (const g of goalRows) {
            const prev = mapRow.get('live', 'donation_goals', String(g.id));
            if (prev && prev.status !== 'held') { report.counts.unchanged++; continue; }
            const creator = subjectOf(g.user_id);
            if (!creator) { record('donation_goals', g.id, { status: 'held', reason: `creator (Live user ${g.user_id}) has no Network subject yet` }); report.counts.held++; continue; }
            const target = Math.round(Number(g.target_amount) || 0);
            if (target <= 0 || !g.title) { record('donation_goals', g.id, { status: 'excluded', reason: 'no title or target' }); report.counts.excluded++; continue; }
            const created = liveTs(g.created_at) || at;
            const id = prefixedId('tgoal', Date.parse(created));
            db.prepare(`INSERT INTO tip_goals (id, creator_subject, title, target_amount, image_url, status, sort_order, reached_at, closed_at, opening_amount, legacy_source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, creator, String(g.title).slice(0, 120), target,
                /^https:\/\//.test(String(g.image_url || '')) ? g.image_url : null, g.is_active ? 'active' : 'closed', Number(g.sort_order) || 0,
                liveTs(g.reached_at), g.is_active ? null : at, Math.max(0, Math.round(Number(g.current_amount) || 0)), `live:donation_goals:${g.id}`, created, at);
            record('donation_goals', g.id, { status: 'imported', target_type: 'goal', target_id: id, reason: `opening_amount ${Math.round(Number(g.current_amount) || 0)} carried over from Live's current_amount` });
            report.counts.goals++;
        }

        if (dryRun) { report.reconciliation = reconcile(domain, billingSource); throw new DryRun(); }
    };

    try { db.transaction(run)(); } catch (e) { if (!(e instanceof DryRun)) throw e; }
    if (!dryRun) report.reconciliation = reconcile(domain, billingSource);
    report.finished_at = iso(domain.now());
    db.prepare('INSERT INTO import_runs (id, source, dry_run, started_at, finished_at, report) VALUES (?, ?, ?, ?, ?, ?)').run(runId, 'live', dryRun ? 1 : 0, report.started_at, report.finished_at, JSON.stringify(report));
    if (log && log.log) log.log(`[Tips] import ${runId}${dryRun ? ' (dry run, rolled back)' : ''}: ${report.counts.imported} tips, ${report.counts.external} external, ${report.counts.goals} goals, ${report.counts.held} held, ${report.counts.excluded} excluded; reconciliation ${report.reconciliation ? (report.reconciliation.ok ? 'OK' : 'MISMATCH') : 'skipped (no Billing source)'}`);
    return report;
}

function pick(row) { return { status: row.status, target_type: row.target_type, target_id: row.target_id, reason: row.reason }; }

/** Per-creator totals: Tips (settled via Billing or imported, non-test, minus refunds) vs Billing. */
function reconcile(domain, billingSource) {
    if (!billingSource) return null;
    const billing = billingSource.creatorTotals();
    const tips = new Map(domain.db.prepare(`SELECT creator_subject AS s, SUM(amount - reversed_bits) AS n FROM tip_interactions
        WHERE test = 0 AND settlement IN ('billing', 'imported') AND payment_state IN ('settled', 'reversed') GROUP BY creator_subject`).all().map((r) => [r.s, r.n]));
    const creators = [...new Set([...billing.keys(), ...tips.keys()])].sort();
    const rows = creators.map((s) => ({ creator: s, tips: tips.get(s) || 0, billing: billing.get(s) || 0, difference: (tips.get(s) || 0) - (billing.get(s) || 0) }));
    const mismatches = rows.filter((r) => r.difference !== 0);
    return { ok: mismatches.length === 0, creators: rows.length, mismatches, rows };
}

module.exports = { importLive, reconcile, billingSnapshotSource, liveTs };
