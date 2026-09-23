'use strict';
/**
 * Stand-ins for the services Tips talks to, each on a random port.
 *
 *   startNetwork()  JWKS, client-credentials token endpoint (scope → cap), user JWTs (signUser)
 *   startBilling()  /api/v1/intents, /transfers, /transfers/:id/refund with Billing's rules that
 *                   matter here (idempotency keys, funds, self-dealing, capability + audience checks),
 *                   and the billing.transaction.* envelopes it would publish (billing.events)
 *   startEvents()   POST /api/v1/events recording what Tips' outbox relays
 *   (Billing and Events also answer GET /api/health, which /api/ready probes)
 *   startLive()     POST /internal/tips/deliveries recording chat deliveries (the live-chat adapter)
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
function readBody(req) {
    return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const grants = [];
    const legacy = {};
    let issuer = 'http://network.test';
    let n = 100;

    function signService({ sub = 'svc:live', aud = ['openvibe.tips'], cap = [], expSec = 300 } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss: issuer, sub, actor_type: 'service', aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex') }, privatePem);
    }
    /** A Network user access token (what the browser holds in ov_token). */
    function signUser(u) {
        return jwt.sign({ sub: String(u.networkId || ++n), subject_id: u.subject, username: u.username, display_name: u.display_name || u.username, role: u.role || 'user' },
            privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
    }
    function newUser(username, liveId) {
        const subject = ids.newId('user');
        if (liveId != null) legacy[String(liveId)] = { subject, username };
        return { subject, username, display_name: username[0].toUpperCase() + username.slice(1) };
    }

    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url === '/api/.well-known/jwks') return send(res, 200, { public_key: publicPem, algorithm: 'RS256' });
        if (req.url === '/oauth/token' && req.method === 'POST') {
            const body = Object.fromEntries(new URLSearchParams(raw));
            grants.push(body);
            if (body.client_secret !== 'shh') return send(res, 401, { error: 'invalid_client' });
            const cap = String(body.scope || '').split(/\s+/).filter(Boolean);
            return send(res, 200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience], cap }), token_type: 'Bearer', expires_in: 300 });
        }
        if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
            const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
            if (!v.ok) return send(res, 401, { code: v.code });
            if (!(v.claims.cap || []).includes('identity.subject.resolve')) return send(res, 403, { code: 'capability.denied' });
            const body = JSON.parse(raw || '{}');
            const results = {};
            for (const id of body.ids || []) {
                const u = body.system === 'live' ? legacy[String(id)] : null;
                results[String(id)] = u ? { subject: { type: 'user', id: u.subject }, username: u.username } : null;
            }
            return send(res, 200, { results });
        }
        send(res, 404, { error: 'not found' });
    });
    const url = await listen(server);
    issuer = url;
    return { url, publicPem, signService, signUser, newUser, legacy, grants, close: () => new Promise((r) => server.close(r)) };
}

/** Billing as Tips sees it. */
async function startBilling(network) {
    const credit = new Map();
    const payable = new Map();
    const txns = new Map();
    const intents = new Map();
    const idem = new Map();
    const calls = [];
    const events = [];
    const state = { down: false };
    const bal = (m, s) => m.get(s) || 0;
    const move = (m, s, d) => m.set(s, bal(m, s) + d);

    function envelope(type, payload, subjectId) {
        return {
            event_id: ids.newId('event'), event_type: type, version: 1, source: 'billing', actor: { type: 'service', id: 'billing' },
            timestamp: new Date().toISOString(), priority: 'important', visibility: 'internal', subject: { type: 'transaction', id: subjectId }, payload,
        };
    }
    const summary = (t) => ({ transaction_id: t.id, type: t.type, test: !!t.test, from_subject: t.from_subject, to_subject: t.to_subject, provider: t.provider || null, metadata: t.metadata, ...(t.reverses_txn ? { reverses_txn: t.reverses_txn } : {}) });
    function record(t, type) { txns.set(t.id, t); const e = envelope(type, summary(t), t.id); events.push(e); return e; }
    const newTxn = (fields) => ({ id: `txn_${ids.ulid()}`, status: 'settled', test: false, created_at: new Date().toISOString(), ...fields });

    function fund(subject, bits) {
        move(credit, subject, bits);
        return record(newTxn({ type: 'purchase', to_subject: subject, provider: 'powerchat', metadata: { bits } }), 'billing.transaction.settled');
    }
    /** The provider paid a checkout: the purchase settles (credit to the buyer) → the settled event. */
    function settlePurchase(intentId, { test = false } = {}) {
        const i = intents.get(intentId);
        move(credit, i.subject.id, i.bits);
        i.status = 'settled';
        return record(newTxn({ type: 'purchase', to_subject: i.subject.id, provider: i.provider, test, metadata: { bits: i.bits, intent_id: i.id } }), 'billing.transaction.settled');
    }
    /** A donation Tips did not start (e.g. Live's own donate flow, or a site-routed PowerChat tip). */
    function foreignDonation({ from, to, amount, provider = null, target = null, message = null, test = false, kind = 'donation' }) {
        if (from) move(credit, from, -amount);
        move(payable, to, amount);
        return record(newTxn({ type: 'donation', from_subject: from || null, to_subject: to, provider, test, metadata: { kind, amount_bits: amount, target, message } }), 'billing.transaction.settled');
    }
    /** Refund a credit-funded transfer (payable → giver credit) outside Tips (operator / Live). */
    function refund(txnId, amount) {
        const o = txns.get(txnId);
        const n = amount || o.metadata.amount_bits;
        move(payable, o.to_subject, -n); move(credit, o.from_subject, n);
        return record(newTxn({ type: 'refund', from_subject: o.to_subject, to_subject: o.from_subject, reverses_txn: o.id, metadata: { amount_bits: n } }), 'billing.transaction.reversed');
    }

    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url === '/api/health') return send(res, state.down ? 503 : 200, state.down ? { code: 'billing.unavailable' } : { ok: true, service: 'billing' });
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ method: req.method, url: req.url, body, key: req.headers['idempotency-key'] || null });
        if (state.down) return send(res, 503, { code: 'billing.unavailable' });
        const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.billing' });
        if (!v.ok) return send(res, 401, { code: v.code });
        const need = req.url.startsWith('/api/v1/intents') ? 'billing.intent.create' : 'billing.transfer.create';
        if (!(v.claims.cap || []).includes(need)) return send(res, 403, { code: 'capability.denied', detail: `${need} not granted` });
        const key = req.headers['idempotency-key'];
        if (req.method === 'POST') {
            if (!key) return send(res, 400, { code: 'idempotency.key_required' });
            if (idem.has(key)) return send(res, idem.get(key).status, idem.get(key).body);
        }
        const ok = (status, out) => { idem.set(key, { status, body: out }); return send(res, status, out); };
        if (req.method === 'POST' && req.url === '/api/v1/intents') {
            if (body.kind !== 'purchase') return send(res, 422, { code: 'billing.invalid_input' });
            if (body.bits < 100) return send(res, 422, { code: 'billing.amount_too_small', detail: 'the minimum purchase is 100 bits' });
            const id = `pi_${ids.ulid()}`;
            const intent = { id, provider: body.provider, kind: 'purchase', subject: body.subject, bits: body.bits, amount_cents: Math.round(body.bits * 1.5), status: 'created', success_url: body.success_url };
            if (body.provider === 'powerchat') intent.checkout_ref = `pcorder:${id}`;
            intents.set(id, intent);
            return ok(201, { intent, checkout_url: body.provider === 'stripe' ? `https://checkout.stripe.test/${id}` : null });
        }
        if (req.method === 'POST' && req.url === '/api/v1/transfers') {
            const from = body.from.id; const to = body.to.id;
            if (from === to) return send(res, 422, { code: 'billing.self_dealing' });
            if (bal(credit, from) < body.amount) return send(res, 409, { code: 'billing.insufficient_funds', detail: `insufficient credit: ${bal(credit, from)} < ${body.amount} vibes-bits` });
            move(credit, from, -body.amount); move(payable, to, body.amount);
            const t = newTxn({ type: 'donation', from_subject: from, to_subject: to, metadata: { kind: body.kind, amount_bits: body.amount, target: body.target || null, message: body.message || null } });
            record(t, 'billing.transaction.settled');
            return ok(201, { transaction: { ...t, reverses_txn: null } });
        }
        const m = req.url.match(/^\/api\/v1\/transfers\/([^/]+)\/refund$/);
        if (req.method === 'POST' && m) {
            const o = txns.get(m[1]);
            if (!o) return send(res, 404, { code: 'billing.transaction_not_found' });
            refund(o.id, body.amount);
            return ok(201, { transaction: [...txns.values()].pop() });
        }
        send(res, 404, { code: 'not_found' });
    });
    const url = await listen(server);
    return {
        url, credit, payable, txns, intents, calls, events, state, fund, settlePurchase, foreignDonation, refund, envelope,
        transfers: () => calls.filter((c) => c.url === '/api/v1/transfers'),
        close: () => new Promise((r) => server.close(r)),
    };
}

async function startEvents() {
    const published = [];
    const tokens = [];
    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url === '/api/health') return send(res, 200, { status: 'ok', service: 'openvibe-events' });
        tokens.push(req.headers.authorization);
        if (req.url === '/api/v1/events' && req.method === 'POST') {
            const b = JSON.parse(raw);
            const list = b.events || [b];
            const results = list.map((e) => { published.push(e); return { event_id: e.event_id, seq: published.length, duplicate: false }; });
            return send(res, 201, b.events ? { results } : results[0]);
        }
        send(res, 404, {});
    });
    const url = await listen(server);
    return { url, published, tokens, close: () => new Promise((r) => server.close(r)) };
}

async function startLive(network) {
    const deliveries = [];
    const state = { fail: null };
    const seen = new Map();
    const server = http.createServer(async (req, res) => {
        const raw = await readBody(req);
        if (req.url !== '/internal/tips/deliveries' || req.method !== 'POST') return send(res, 404, {});
        const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: network.publicPem, issuer: network.url, audience: 'openvibe.live' });
        if (!v.ok) return send(res, 401, { code: v.code });
        if (!(v.claims.cap || []).includes('live.tips_delivery.write')) return send(res, 403, { code: 'capability.denied' });
        if (state.fail) return send(res, state.fail, { code: 'live.refused', detail: 'stub refusal' });
        const key = req.headers['idempotency-key'];
        if (seen.has(key)) return send(res, 200, seen.get(key));
        const job = JSON.parse(raw);
        deliveries.push({ key, job });
        const out = { ok: true, ref: { chat_message_id: deliveries.length } };
        seen.set(key, out);
        return send(res, 200, out);
    });
    const url = await listen(server);
    return { url, deliveries, state, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { startNetwork, startBilling, startEvents, startLive };
