'use strict';
/**
 * ADR-033: Tips' part of an account export and of an account deletion, through the signed /internal/events route with
 * a stand-in Network. A creator's settings, overlays and moderator links go while the money records stay (Billing's
 * books and the totals reconcile); a supporter goes through the erasure Tips already offers (the amount stays, the
 * person goes, a pending payment is kept); each deletion is confirmed once with its counts.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');
const { createNetworkSender } = require('openvibe-sdk/account-data');

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_tips', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const envelope = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'network' }, subject: { type: 'account', id: payload.subject }, visibility: 'internal', payload });

(async () => {
    const stub = await startNetworkStub();
    const t = await boot({ appOpts: { accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'tips', clientSecret: 'shh' }) } });
    const { domain, billing } = t;
    const count = async (sql, args) => Number(await t.db.value(sql, args));
    const alex = await t.creator('alex');
    const bea = await t.creator('bea');
    const mod = t.network.newUser('moddy');
    const buyer = t.network.newUser('buyer');
    billing.fund(buyer.subject, 10_000);
    const tip = (user, body) => t.call('POST', '/api/v1/checkout', { user, body: { creator: 'alex', ...body } });
    let settled;

    try {
        await check('a creator, a supporter and moderators make their rows through the app', async () => {
            assert.strictEqual((await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 100_000 } })).status, 201);
            assert.strictEqual((await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts', 'goals'] } })).status, 201);
            await domain.moderation.addModerator(t.db, alex.subject, mod.subject, { name: 'Moddy', addedBy: alex.subject });
            await domain.moderation.addModerator(t.db, bea.subject, alex.subject, { name: 'Alex', addedBy: bea.subject });
            settled = await tip(buyer, { amount: 40, message: 'my secret words', supporter_name: 'Buyer Person' });
            assert.strictEqual(settled.status, 201, settled.text);
            assert.strictEqual((await tip(buyer, { amount: 150, pay_with: 'checkout', provider: 'stripe', message: 'pending one' })).status, 201);
        });

        await check('the creator\'s export: their settings, overlays (no token hash), goals, tips received and moderators', async () => {
            const r = await t.deliver(envelope('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: alex.subject }));
            assert.strictEqual(r.status, 200, JSON.stringify(r.json));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
            assert.strictEqual(part.auth, 'Bearer tok_tips');
            const files = Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));
            for (const f of ['creator-profile.json', 'overlay-tokens.json', 'goals.json', 'tips-received.json', 'moderators.json', 'moderating.json']) assert.ok(files[f], `${f} is in the part`);
            assert.ok(!JSON.stringify(files['overlay-tokens.json']).includes('token_hash'));
            assert.ok(!JSON.stringify(files['tips-received.json']).includes(buyer.subject), 'the supporters of their tips are not theirs to read');
            assert.ok(!JSON.stringify(files['tips-received.json']).includes('my secret words'));
        });

        await check('the supporter\'s export is the one /me/export gives', async () => {
            await t.deliver(envelope('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: buyer.subject }));
            const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX2/parts');
            const sent = part.body.files.find((f) => f.name === 'tips-sent.json').content;
            assert.strictEqual(sent.interactions.length, 2);
            assert.ok(JSON.stringify(sent).includes('my secret words'), 'their own message, to them');
        });

        await check('deleting the creator removes their settings, overlays and moderator links, and keeps the money records', async () => {
            const before = await domain.interactions.totals(t.db, alex.subject);
            const r = await t.deliver(envelope('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: alex.subject }));
            assert.strictEqual(r.status, 200, JSON.stringify(r.json));
            const a = [alex.subject];
            assert.strictEqual(await count('SELECT count(*) FROM creator_tip_profiles WHERE creator_subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM overlay_tokens WHERE creator_subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM tip_moderators WHERE creator_subject = $1 OR moderator_subject = $1', a), 0);
            assert.strictEqual(await count('SELECT count(*) FROM creator_tip_profiles WHERE creator_subject = $1', [bea.subject]), 1, 'bea stays');
            assert.deepStrictEqual(await domain.interactions.totals(t.db, alex.subject), before, 'the totals still reconcile');
            assert.strictEqual(await count('SELECT count(*) FROM tip_goals WHERE creator_subject = $1', a), 1, 'the goal stays: contributions reference it');
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
            assert.strictEqual(conf.length, 1);
            assert.strictEqual(conf[0].body.erased.creator_tip_profiles, 1);
            assert.strictEqual(conf[0].body.erased.tip_moderators, 2);
            assert.strictEqual(conf[0].body.retained.tip_interactions, 2);
            assert.ok(conf[0].body.erased.api_idempotency >= 1, 'stored API answers that name the creator go too (the supporters\' checkout answers)');
        });

        await check('deleting the supporter erases them from their tips, keeps the amount and the pending payment, and confirms once', async () => {
            const body = envelope('evt_01JZ0000000000000000000D02', 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE2', subject: buyer.subject });
            assert.strictEqual((await t.deliver(body)).status, 200);
            const i = await domain.interactions.get(t.db, settled.json.interaction.id);
            assert.deepStrictEqual([i.supporter_subject, i.supporter_name, i.message, i.amount], [null, null, null, 40]);
            assert.ok(i.erased_at);
            assert.strictEqual(await count('SELECT count(*) FROM tip_interactions WHERE supporter_subject = $1', [buyer.subject]), 1, 'the pending payment keeps its supporter');
            const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE2/confirmations');
            assert.strictEqual(conf.length, 1);
            assert.strictEqual(conf[0].body.retained.tombstones, 1);
            assert.strictEqual(conf[0].body.retained.tip_interactions_pending, 1);
            assert.strictEqual((await t.deliver(body)).json.outcome, 'unchanged', 'a redelivery changes nothing');
            assert.strictEqual(stub.calls.filter((c) => c.url.includes('DE2/confirmations')).length, 1);
        });
    } finally {
        await t.close();
        await stub.close();
    }
    done();
})();
