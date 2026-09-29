'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 public key (OV_NETWORK_PUBLIC_KEY, else GET /api/.well-known/jwks,
 *             refreshed every 6 h and retried every 30 s until it loads). It verifies service tokens
 *             (audience openvibe.tips) and the browser's Network user JWT, both offline.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

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
        timer = setInterval(async () => { await load(); }, 6 * 60 * 60 * 1000);
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

module.exports = { createKeyProvider, createUserAuth };
