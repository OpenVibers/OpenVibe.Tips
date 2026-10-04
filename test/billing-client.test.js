'use strict';
// server/billing-client.js is a thin wrapper over openvibe-sdk/commerce: the same exported names,
// one token with the same scope for every call, the same request bodies, the Idempotency-Key sent
// unchanged on the one retry after a 401, and BillingCallError is commerce's error.
const assert = require('assert');
const { check, done } = require('./helpers/app');
const { CommerceError } = require('openvibe-sdk/commerce');
const { createBillingClient, BillingCallError } = require('../server/billing-client');

const config = { billing: { url: 'http://billing.test', audience: 'openvibe.billing' }, network: { internalUrl: 'http://network.test' }, oauth: { clientId: 'tips', clientSecret: 's' } };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeBilling(answer) {
    const seen = [];
    let tokens = 0;
    const fetchImpl = async (url, init) => {
        if (url.endsWith('/oauth/token')) {
            seen.push({ token: new URLSearchParams(init.body).get('scope') });
            return json(200, { access_token: `t${++tokens}`, token_type: 'Bearer', expires_in: 300 });
        }
        const call = { method: init.method, path: url.slice(config.billing.url.length), key: init.headers['Idempotency-Key'], auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
        seen.push(call);
        return answer(call, seen);
    };
    return { seen, fetchImpl };
}

(async () => {
    await check('the exports are unchanged and BillingCallError is commerce\'s CommerceError', async () => {
        assert.strictEqual(typeof createBillingClient, 'function');
        assert.strictEqual(BillingCallError, CommerceError);
        const e = new BillingCallError('x', { status: 409, code: 'billing.frozen' });
        assert.ok(e.retryable);
        assert.ok(!new BillingCallError('x', { status: 402, code: 'billing.insufficient_funds' }).retryable);
        assert.ok(new BillingCallError('x').retryable);
    });

    await check('one token with the combined scope; the same bodies and keys; a 401 is retried once with the same key', async () => {
        const { seen, fetchImpl } = fakeBilling((call, all) => (all.filter((c) => c.method).length === 1 ? json(401, {}) : json(200, { ok: true })));
        const billing = createBillingClient(config, { fetchImpl });
        await billing.createIntent({ provider: 'stripe', subject: 'u1', bits: 100, successUrl: 'https://s', cancelUrl: 'https://c', key: 'tips:intent:i1' });
        await billing.createTransfer({ from: 'u1', to: 'u2', amount: 5, kind: 'tip', target: { type: 'tips.interaction', id: 'i1' }, key: 'tips:transfer:i1' });
        await billing.refundTransfer({ txnId: 'txn/1', amount: 5, reason: 'not played', key: 'tips:refund:i1' });
        await billing.rates();
        const tokens = seen.filter((c) => c.token);
        assert.deepStrictEqual(tokens.map((c) => c.token), ['billing.intent.create billing.transfer.create', 'billing.intent.create billing.transfer.create']);
        const calls = seen.filter((c) => c.method);
        assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.path} ${c.key || ''}`), [
            'POST /api/v1/intents tips:intent:i1', 'POST /api/v1/intents tips:intent:i1',
            'POST /api/v1/transfers tips:transfer:i1', 'POST /api/v1/transfers/txn%2F1/refund tips:refund:i1', 'GET /api/v1/rates ',
        ]);
        assert.deepStrictEqual([calls[0].auth, calls[1].auth], ['Bearer t1', 'Bearer t2']);
        assert.deepStrictEqual(calls[1].body, { provider: 'stripe', kind: 'purchase', subject: { type: 'user', id: 'u1' }, bits: 100, success_url: 'https://s', cancel_url: 'https://c' });
        assert.deepStrictEqual(calls[2].body, { from: { type: 'user', id: 'u1' }, to: { type: 'user', id: 'u2' }, amount: 5, kind: 'tip', target: { type: 'tips.interaction', id: 'i1' } });
        assert.deepStrictEqual(calls[3].body, { amount: 5, reason: 'not played' });
    });

    await check('a passed token client is used verbatim; a problem+json becomes a BillingCallError', async () => {
        const { seen, fetchImpl } = fakeBilling(() => json(402, { type: 'about:blank', code: 'billing.insufficient_funds', detail: 'not enough credit' }));
        const tokenClient = { authHeaders: async () => ({ Authorization: 'Bearer injected' }), invalidate() {} };
        const billing = createBillingClient(config, { fetchImpl, tokenClient });
        const e = await billing.createTransfer({ from: 'u1', to: 'u2', amount: 5, kind: 'tip', key: 'tips:transfer:i2' }).catch((err) => err);
        assert.ok(e instanceof BillingCallError);
        assert.strictEqual(e.status, 402);
        assert.strictEqual(e.code, 'billing.insufficient_funds');
        assert.ok(!e.retryable);
        assert.ok(!seen.some((c) => c.token));
        assert.strictEqual(seen[0].auth, 'Bearer injected');
    });

    done();
})();
