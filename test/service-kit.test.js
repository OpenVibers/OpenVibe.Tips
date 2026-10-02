'use strict';
/**
 * openvibe-sdk/service (plan T1): Tips' error half is the kit's wrap/sendError with Tips' options, so a
 * TipsError answers its own status/code/detail with `extra` nested as { details } below 500, and anything
 * else answers 500 tips.internal with 'internal error'. The kit's JSON parser (wired the way a service
 * adopts it) answers 413 request.too_large / 400 request.invalid_json / 415 request.unsupported_encoding;
 * Tips' own app keeps express.json, so its current codes are pinned unchanged (413 request.too_large,
 * 400 request.malformed_json). The entry point's graceful stop runs its stop and close steps in order,
 * then exits 0.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const svc = require('openvibe-sdk/service');
const { boot, check, done } = require('./helpers/app');
const { wrap } = require('../server/api/v1');
const { TipsError } = require('../server/util');

(async () => {
    const t = await boot();

    // A service-shaped app on the kit's parser + Tips' wrap, the way the recipe wires it.
    const app = express();
    app.post('/echo', svc.jsonBody({ limit: '64kb' }), wrap(async (req, res) => { res.json({ ok: true }); }));
    app.post('/refuse', wrap(async () => { throw new TipsError(422, 'tips.test_refusal', 'that is not allowed', { field: 'creator' }); }));
    app.post('/gone', wrap(async () => { throw new TipsError(503, 'tips.billing_unavailable', 'Billing is not answering right now; nothing was charged'); }));
    app.post('/boom', wrap(async () => { throw new Error('boom'); }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const read = async (r) => { const text = await r.text(); return { status: r.status, headers: r.headers, text, json: JSON.parse(text) }; };

    await check('the kit parser: a JSON body over 64 kB is 413 request.too_large', async () => {
        const r = await read(await post('/echo', JSON.stringify({ padding: 'y'.repeat(70 * 1024) })));
        assert.strictEqual(r.status, 413, r.text);
        assert.strictEqual(r.json.code, 'request.too_large');
    });

    await check('the kit parser: malformed JSON is 400 request.invalid_json', async () => {
        const r = await read(await post('/echo', '{oops'));
        assert.strictEqual(r.status, 400, r.text);
        assert.strictEqual(r.json.code, 'request.invalid_json');
    });

    await check('the kit parser: an unreadable Content-Encoding is 415 request.unsupported_encoding', async () => {
        const r = await read(await post('/echo', '{}', { 'content-encoding': 'xz' }));
        assert.strictEqual(r.status, 415, r.text);
        assert.strictEqual(r.json.code, 'request.unsupported_encoding');
    });

    await check('Tips\' app keeps its own parser answers: over 64 kB 413 request.too_large, malformed 400 request.malformed_json', async () => {
        const big = await read(await fetch(`${t.base}/api/v1/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'y'.repeat(70 * 1024) }) }));
        assert.strictEqual(big.status, 413, big.text);
        assert.strictEqual(big.json.code, 'request.too_large');
        const bad = await read(await fetch(`${t.base}/api/v1/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }));
        assert.strictEqual(bad.status, 400, bad.text);
        assert.strictEqual(bad.json.code, 'request.malformed_json');
    });

    await check('a TipsError answers its own status/code/detail and nests extra as { details } below 500', async () => {
        const r = await read(await post('/refuse', '{}'));
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json.code, 'tips.test_refusal');
        assert.strictEqual(r.json.detail, 'that is not allowed');
        assert.deepStrictEqual(r.json.details, { field: 'creator' });
        assert.strictEqual(r.json.error, 'that is not allowed');
    });

    await check('a 503 TipsError keeps its detail (the fallback detail is only for an unexpected 500)', async () => {
        const r = await read(await post('/gone', '{}'));
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.code, 'tips.billing_unavailable');
        assert.strictEqual(r.json.detail, 'Billing is not answering right now; nothing was charged');
        assert.strictEqual(r.json.details, undefined);
    });

    await check('an unexpected throw answers 500 tips.internal with \'internal error\'', async () => {
        const r = await read(await post('/boom', '{}'));
        assert.strictEqual(r.status, 500, r.text);
        assert.strictEqual(r.json.code, 'tips.internal');
        assert.strictEqual(r.json.detail, 'internal error');
    });

    await check('the entry point stop runs its stop and close steps in order, then exits 0', async () => {
        const steps = [];
        const spy = (obj, method, label) => { const orig = obj[method].bind(obj); obj[method] = (...a) => { steps.push(label); return orig(...a); }; };
        spy(t.app.locals.keys, 'stop', 'keys.stop');
        spy(t.app.locals.domain.overlays, 'close', 'overlays.close');
        spy(t.app.locals.outbox, 'stop', 'outbox.stop');
        spy(t.app.locals.db, 'close', 'db.close');
        const closesValkey = !!(t.app.locals.valkey && typeof t.app.locals.valkey.close === 'function');
        if (closesValkey) spy(t.app.locals.valkey, 'close', 'valkey.close');

        const stopServer = http.createServer(t.app);
        await new Promise((resolve) => stopServer.listen(0, '127.0.0.1', resolve));

        const { createLifecycle } = require('../server/index');
        const exits = [];
        const lifecycle = createLifecycle({ server: stopServer, app: t.app, timers: [], exit: (code) => exits.push(code), signals: false });
        const code = await lifecycle.stop('SIGTERM');

        const expected = ['keys.stop', 'overlays.close', 'outbox.stop', 'db.close'];
        if (closesValkey) expected.push('valkey.close');
        assert.strictEqual(code, 0);
        assert.deepStrictEqual(exits, [0]);
        assert.deepStrictEqual(steps, expected);
        assert.strictEqual(stopServer.listening, false);
    });

    server.close();
    try { await t.close(); } catch { /* the lifecycle above already closed the db and valkey */ }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
