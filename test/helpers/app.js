'use strict';
/**
 * Boots Tips against the stubs on a random port with a temp database. Jobs are off: tests drive the
 * effects worker and transfer retries explicitly (domain.effects.drain(), processDueTransfers()).
 *
 *   t.call(method, path, { body, user, cap, sub, key })   user: a stub user → Bearer user JWT;
 *                                                          otherwise a service token with `cap`
 *   t.deliver(envelope)                                   a signed OpenVibe.Events delivery to /internal/events
 *   t.sse(path, { lastEventId })                          an SSE reader
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { signDelivery } = require('openvibe-sdk/events');
const { startNetwork, startBilling, startEvents, startLive } = require('./stubs');

const EVENTS_SECRET = 'e'.repeat(48);

async function boot(opts = {}) {
    const network = await startNetwork();
    const billing = await startBilling(network);
    const events = await startEvents();
    const live = opts.live ? await startLive(network) : null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tips-test-'));
    const env = {
        NODE_ENV: 'test',
        TIPS_DB_PATH: path.join(dir, 'tips.db'),
        BASE_URL: 'http://tips.test',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        OV_OAUTH_CLIENT_ID: 'tips',
        OV_OAUTH_CLIENT_SECRET: 'shh',
        TIPS_FORM_SECRET: 'form-secret-for-tests',
        BILLING_URL: billing.url,
        TIPS_CHECKOUT_PROVIDERS: 'powerchat,stripe',
        TIPS_EVENTS_SECRET: EVENTS_SECRET,
        EVENTS_URL: events.url,
        EVENTS_RELAY_INTERVAL_MS: '50',
        TIPS_JOBS: 'off',
        TIPS_CHAT_ADAPTER: live ? 'live-chat' : 'test',
        LIVE_INTERNAL_URL: live ? live.url : 'http://127.0.0.1:9',
        TIPS_OVERLAY_HEARTBEAT_MS: '60000',
        ...(opts.env || {}),
    };
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
    const { loadConfig } = require('../../server/config');
    const { createApp } = require('../../server/app');
    const config = loadConfig(env);
    const clock = { offset: 0 };
    const logs = [];
    const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    const app = createApp({ config, now: () => Date.now() + clock.offset, log });
    await app.locals.keys.load();
    const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const domain = app.locals.domain;

    let n = 0;
    async function call(method, p, { body, user, cap = ['tips.*'], sub = 'svc:live', key, token, headers = {} } = {}) {
        const h = { ...headers };
        if (token !== null) h.Authorization = `Bearer ${token || (user ? network.signUser(user) : network.signService({ sub, cap }))}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if ((method === 'POST' || method === 'PATCH') && key !== null) h['Idempotency-Key'] = key || `test-${process.pid}-${++n}-${crypto.randomBytes(4).toString('hex')}`;
        const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* html */ }
        return { status: res.status, headers: res.headers, json, text };
    }

    /** POST a signed Events delivery of `event` (as OpenVibe.Events would). */
    async function deliver(event, { secret = EVENTS_SECRET, seq = 1 } = {}) {
        const raw = JSON.stringify({ event, seq });
        const res = await fetch(`${base}/internal/events`, {
            method: 'POST', body: raw,
            headers: { 'Content-Type': 'application/json', 'X-OpenVibe-Signature': signDelivery(raw, secret), 'X-OpenVibe-Seq': String(seq) },
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    }

    /** Minimal SSE reader: .events [{ id, event, data }], .waitFor(pred), .close(), .ended */
    function sse(p, { lastEventId } = {}) {
        return new Promise((resolve, reject) => {
            const headers = { Accept: 'text/event-stream' };
            if (lastEventId != null) headers['Last-Event-ID'] = String(lastEventId);
            const req = http.get(base + p, { headers }, (res) => {
                const reader = { status: res.status || res.statusCode, events: [], ended: false, waiters: [] };
                let buf = '';
                const check = () => { reader.waiters = reader.waiters.filter((w) => { const hit = reader.events.find(w.pred); if (hit) { w.resolve(hit); return false; } return true; }); };
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    buf += chunk;
                    let i;
                    while ((i = buf.indexOf('\n\n')) >= 0) {
                        const block = buf.slice(0, i); buf = buf.slice(i + 2);
                        const e = { id: null, event: 'message', data: null };
                        for (const line of block.split('\n')) {
                            if (line.startsWith('id: ')) e.id = Number(line.slice(4));
                            else if (line.startsWith('event: ')) e.event = line.slice(7);
                            else if (line.startsWith('data: ')) e.data = JSON.parse(line.slice(6));
                        }
                        if (e.data != null) reader.events.push(e);
                    }
                    check();
                });
                res.on('end', () => { reader.ended = true; reader.waiters.forEach((w) => w.resolve(null)); reader.waiters = []; });
                reader.waitFor = (pred, ms = 3000) => new Promise((ok, fail) => {
                    const hit = reader.events.find(pred);
                    if (hit) return ok(hit);
                    if (reader.ended) return ok(null);
                    const w = { pred, resolve: ok };
                    reader.waiters.push(w);
                    setTimeout(() => { reader.waiters = reader.waiters.filter((x) => x !== w); fail(new Error(`SSE wait timed out; got ${JSON.stringify(reader.events.map((x) => x.event))}`)); }, ms).unref();
                });
                reader.close = () => req.destroy();
                reader.statusCode = res.statusCode;
                resolve(reader);
            });
            req.on('error', reject);
        });
    }

    /** A creator with a profile (page on unless told otherwise). */
    async function creator(username, profile = {}) {
        const u = network.newUser(username, profile.liveId);
        const r = await call('PATCH', '/api/v1/profiles/me', { user: u, body: { page_enabled: true, ...profile.settings } });
        if (r.status !== 200) throw new Error(`creator setup: ${r.status} ${r.text}`);
        return u;
    }

    const outboxRows = (type) => domain.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope)).filter((e) => !type || e.event_type === type);

    return {
        app, base, call, deliver, sse, creator, domain, db: domain.db, config, clock, network, billing, events, live, logs, dir, outboxRows,
        adapters: app.locals.adapters,
        close: async () => {
            domain.overlays.closeAll();
            await new Promise((r) => server.close(r));
            await app.locals.outbox.stop();
            await Promise.all([network.close(), billing.close(), events.close(), live && live.close()]);
            try { domain.db.close(); } catch { /* */ }
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, EVENTS_SECRET };
