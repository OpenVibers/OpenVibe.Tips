'use strict';

/**
 * OpenVibe.Network client.
 *
 *   keys      the Network's RS256 signing keys through openvibe-sdk/auth: one process-wide JWKS client per URL keeps
 *             them fresh, serves the last good keys through a Network outage, backs off, and refetches at once when a
 *             token names a key it does not have (a rotation). OV_NETWORK_PUBLIC_KEY pins one key instead. Service
 *             tokens (audience openvibe.tips) and the browser's Network user JWT are both verified offline.
 */
const crypto = require('crypto');
const contracts = require('openvibe-contracts');
const { jwksClient, verifyUserToken, verifyServiceToken } = require('openvibe-sdk/auth');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

function createKeyProvider(config, { fetchImpl = globalThis.fetch, log = console } = {}) {
    const url = `${config.network.internalUrl}/api/.well-known/jwks`;
    const pinned = config.network.publicKey ? crypto.createPublicKey(config.network.publicKey) : null;
    const client = pinned ? null : jwksClient(url, { fetch: fetchImpl, log });
    /** Where a verification takes its keys from (openvibe-sdk/auth options). */
    const source = pinned ? { publicKey: pinned } : { jwks: url, fetch: fetchImpl };
    return {
        source,
        ready: () => (pinned ? true : client.status().ready),
        /** Fetch the keys now (boot, tests); true when there is a key to verify with. */
        async load() { if (client) await client.refresh().catch(() => {}); return pinned ? true : client.status().ready; },
        start() { if (client) client.start(); },
        stop() { if (client) client.stop(); },
    };
}

/** A service principal's token (audience openvibe.tips): contracts' result { ok, code, reason, claims }. */
async function verifyService(config, keys, token) {
    return await verifyServiceToken(token, { ...keys.source, issuer: config.network.issuer, audience: config.audience, contracts });
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
    /**
     * Claims of a valid user token, or null. openvibe-sdk/auth refuses service, app and mod principals and typed
     * tokens (a realtime ticket, an export token): none of them is a session.
     */
    async function verify(token) {
        if (!token) return null;
        try { return await verifyUserToken(token, { ...keys.source, issuer: config.network.issuer }); } catch { return null; }
    }
    return { client, verify };
}

module.exports = { createKeyProvider, createUserAuth, verifyService };
