'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 public key (OV_NETWORK_PUBLIC_KEY, else GET /api/.well-known/jwks,
 *             refreshed every 6 h and retried every 30 s until it loads). It verifies service tokens
 *             (audience openvibe.tips) and the browser's Network user JWT, both offline.
 *   identity  Live user ids → canonical subjects via POST /internal/identity/resolve-batch
 *             (capability identity.subject.resolve, audience openvibe.network) — the importer only.
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');
const jwt = require('jsonwebtoken');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

const BATCH = 500;

function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    let pem = config.network.publicKey ? crypto.createPublicKey(config.network.publicKey).export({ type: 'spki', format: 'pem' }) : null;
    let timer = null;
    async function load() {
        const url = `${config.network.internalUrl}/api/.well-known/jwks`;
        try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) throw new Error(`JWKS ${res.status}`);
            const body = await res.json();
            const jwk = (body.keys || []).find((k) => k.kty === 'RSA');
            if (jwk) pem = crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
            else if (typeof body.public_key === 'string') pem = crypto.createPublicKey(body.public_key).export({ type: 'spki', format: 'pem' });
            else throw new Error('JWKS contained no keys');
            return pem;
        } catch (e) {
            log.warn(`[Tips] Network key not loaded from ${url}: ${e.message}`);
            return null;
        }
    }
    function start() {
        if (config.network.publicKey || timer) return;
        const retry = () => load().then((k) => { if (!k) setTimeout(retry, 30_000).unref(); });
        retry();
        timer = setInterval(() => { load(); }, 6 * 60 * 60 * 1000);
        timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { get: () => pem, load, start, stop };
}

/**
 * The OAuth client of the browser session layer plus offline verification of the Network user
 * JWT (RS256, issuer = the Network's public URL).
 */
function createUserAuth(config, keys) {
    const client = new OpenVibeAuthClient({
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        publicKey: null,
        authBase: config.network.url,
        internalBase: config.network.internalUrl,
    });
    /** Claims of a valid user token, or null. Service tokens are never user tokens. */
    function verify(token) {
        if (!token) return null;
        const key = keys.get();
        if (!key) return null;
        let claims;
        try { claims = jwt.verify(token, key, { algorithms: ['RS256'], issuer: config.network.issuer }); } catch { return null; }
        if (!claims || typeof claims !== 'object') return null;
        if (typeof claims.sub === 'string' && /^(svc|app|mod):/.test(claims.sub)) return null;
        if (claims.actor_type === 'service') return null;
        return claims;
    }
    return { client, verify };
}

function createIdentity(config, { fetchImpl = globalThis.fetch } = {}) {
    const base = config.network.internalUrl;
    let tokens = null;
    const tokenClient = () => {
        if (!tokens) {
            tokens = serviceAuth.createTokenClient({
                tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
                audience: 'openvibe.network', scope: 'identity.subject.resolve', fetchImpl,
            });
        }
        return tokens;
    };

    async function post(body, retried = false) {
        const res = await fetchImpl(`${base}/internal/identity/resolve-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokenClient().authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (res.status === 401 && !retried) { tokenClient().invalidate(); return post(body, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data.results !== 'object') throw new Error(`resolve-batch ${res.status}: ${(data && (data.detail || data.error)) || 'bad response'}`);
        return data.results;
    }

    /** Live user ids → Map(String(id) → { subject, username } | null). */
    async function resolveLiveUsers(liveIds) {
        const out = new Map();
        const all = [...new Set(liveIds.map(String))];
        for (let i = 0; i < all.length; i += BATCH) {
            const chunk = all.slice(i, i + BATCH);
            const results = await post({ system: 'live', type: 'user', ids: chunk });
            for (const k of chunk) {
                const p = results[k];
                out.set(k, p && p.subject && p.subject.type === 'user' ? { subject: p.subject.id, username: p.username || null } : null);
            }
        }
        return out;
    }
    return { resolveLiveUsers };
}

module.exports = { createKeyProvider, createUserAuth, createIdentity };
