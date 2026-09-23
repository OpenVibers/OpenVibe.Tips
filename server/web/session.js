'use strict';

/**
 * openvibe.tips — OAuth2 client session layer (identity provider: OpenVibe.Network), the same
 * shape as OpenVibe.Community's server/auth/routes.js. Registered in the Network as client `tips`
 * with redirect https://openvibe.tips/auth/callback.
 *
 *   GET  /auth/login     → Network /oauth/authorize (?silent=1 → prompt=none; ?next= same-site path)
 *   GET  /auth/callback  → server-side code exchange, session cookies
 *   POST /auth/fedcm     → the shared navbar's FedCM assertion → tokens (jwt-bearer grant)
 *   GET  /auth/logout    → clear cookies (best-effort refresh revoke), hint=guest
 *   GET  /auth/me        → the signed-in user (offline JWT verification)
 *   POST /auth/refresh   → rotate tokens
 *
 * Cookies (host-only): ov_token (access JWT, Lax, JS-readable for the navbar), ov_refresh (httpOnly,
 * Path=/auth), ov_sso_hint. These cookies only ever sign a person into the pages of this site;
 * overlays never use them (overlays hold their own revocable tokens).
 */
const express = require('express');
const crypto = require('crypto');
const { userPrincipal } = require('../api/auth');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const HINT_COOKIE = 'ov_sso_hint';
const STATE_COOKIE = 'ov_oauth_state';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';

function claimsToUser(claims) {
    if (!claims) return null;
    const { iat, exp, aud, iss, nbf, jti, ...user } = claims;   // eslint-disable-line no-unused-vars
    return user;
}

function decodeJwtPayload(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try { const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); return c && typeof c === 'object' ? c : null; } catch { return null; }
}

function sanitizeNext(next, config) {
    if (!next || typeof next !== 'string') return '/';
    if (/^\/(?!\/|\\)/.test(next)) return next;
    try {
        const u = new URL(next);
        if (u.protocol !== 'https:') return '/';
        const allowed = [config.baseUrl, config.network.url].map((b) => { try { return new URL(b).hostname; } catch { return null; } }).filter(Boolean);
        if (allowed.includes(u.hostname)) return u.toString();
    } catch { /* fall through */ }
    return '/';
}

function withParam(target, key, value) {
    const hashAt = target.indexOf('#');
    const hash = hashAt >= 0 ? target.slice(hashAt) : '';
    const base = hashAt >= 0 ? target.slice(0, hashAt) : target;
    return `${base}${base.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
}

/** Page middleware: req.viewer = the signed-in person (principal shape) or null. Never blocks. */
function viewerMiddleware(userAuth) {
    return (req, _res, next) => {
        const token = req.cookies && req.cookies[ACCESS_COOKIE];
        const claims = token ? userAuth.verify(token) : null;
        req.viewer = claims ? userPrincipal(claims) : null;
        req.viewerClaims = claims ? claimsToUser(claims) : null;
        next();
    };
}

function createSessionRoutes(config, userAuth, { fetchImpl = globalThis.fetch } = {}) {
    const router = express.Router();
    const secure = config.cookies.secure;
    const accessOpts = () => ({ sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 24 * 3600 * 1000 });
    const refreshOpts = () => ({ sameSite: 'lax', secure, httpOnly: true, path: '/auth', maxAge: 30 * 24 * 3600 * 1000 });
    const flowOpts = () => ({ sameSite: 'lax', secure, httpOnly: true, path: '/auth', maxAge: 10 * 60 * 1000 });
    const hintOpts = () => ({ sameSite: 'lax', secure, httpOnly: false, path: '/', maxAge: 365 * 24 * 3600 * 1000 });

    function setSession(res, access, refresh) {
        res.cookie(ACCESS_COOKIE, access, accessOpts());
        if (refresh) res.cookie(REFRESH_COOKIE, refresh, refreshOpts());
        res.cookie(HINT_COOKIE, 'account', hintOpts());
    }
    function clearSession(res) {
        res.clearCookie(ACCESS_COOKIE, { ...accessOpts(), maxAge: undefined });
        res.clearCookie(REFRESH_COOKIE, { ...refreshOpts(), maxAge: undefined });
    }
    function clearFlow(res) { for (const c of [STATE_COOKIE, NEXT_COOKIE, SILENT_COOKIE]) res.clearCookie(c, { path: '/auth' }); }

    async function tokenGrant(body) {
        let lastErr = null;
        for (const base of [config.network.internalUrl, config.network.url]) {
            if (!base) continue;
            try {
                const res = await fetchImpl(`${base}/oauth/token`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, ...body }),
                    signal: AbortSignal.timeout(10_000),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const err = new Error(data.error_description || data.error || `token grant failed (${res.status})`);
                    err.status = res.status; err.error = data.error || 'invalid_grant';
                    throw err;
                }
                return data;
            } catch (err) {
                lastErr = err;
                if (err.status && err.status < 500) throw err;
            }
        }
        throw lastErr || new Error('Network unreachable');
    }

    router.get('/login', (req, res) => {
        const silent = !!req.query.silent && req.query.silent !== '0';
        if (silent && userAuth.verify(req.cookies && req.cookies[ACCESS_COOKIE])) { clearFlow(res); return res.redirect(sanitizeNext(req.query.next, config)); }
        const { url, state } = userAuth.client.getAuthorizationUrl(config.oauth.scope);
        let target = url;
        if (silent) { const u = new URL(url); u.searchParams.set('prompt', 'none'); target = u.toString(); }
        res.cookie(STATE_COOKIE, state, flowOpts());
        const next = sanitizeNext(req.query.next, config);
        if (next !== '/') res.cookie(NEXT_COOKIE, next, flowOpts()); else res.clearCookie(NEXT_COOKIE, { path: '/auth' });
        if (silent) res.cookie(SILENT_COOKIE, '1', flowOpts()); else res.clearCookie(SILENT_COOKIE, { path: '/auth' });
        res.redirect(target);
    });

    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        const next = sanitizeNext(req.cookies && req.cookies[NEXT_COOKIE], config);
        const silent = req.cookies && req.cookies[SILENT_COOKIE] === '1';
        if (error) {
            clearFlow(res);
            if (silent || error === 'login_required') return res.redirect(withParam(next, 'sso', 'none'));
            return res.redirect(withParam('/', 'auth_error', String(error)));
        }
        if (!code) return res.status(400).type('text/plain').send('Missing authorization code');
        const expected = req.cookies && req.cookies[STATE_COOKIE];
        clearFlow(res);
        if (!expected || !state || !crypto.timingSafeEqual(Buffer.from(String(state).padEnd(64).slice(0, 64)), Buffer.from(String(expected).padEnd(64).slice(0, 64)))) {
            return res.status(400).type('text/plain').send('Sign-in state mismatch — please try signing in again.');
        }
        try {
            const data = await tokenGrant({ grant_type: 'authorization_code', redirect_uri: config.oauth.redirectUri, code });
            setSession(res, data.access_token, data.refresh_token);
            return res.redirect(next);
        } catch (err) {
            console.error('[Tips] code exchange failed:', err.message);
            return res.status(502).type('text/plain').send('Sign-in failed — could not reach OpenVibe.Network. Please try again.');
        }
    });

    const fedcmBody = express.json({ limit: '16kb' });
    router.post('/fedcm', fedcmBody, async (req, res) => {
        const { token, nonce } = req.body || {};
        if (typeof token !== 'string' || !token || typeof nonce !== 'string' || !nonce || nonce.length > 256) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'token and nonce are required' });
        }
        const claims = decodeJwtPayload(token);
        const a = Buffer.from(String((claims && claims.nonce) || '')); const b = Buffer.from(nonce);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).json({ error: 'invalid_request', error_description: 'nonce mismatch' });
        try {
            const data = await tokenGrant({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: token });
            if (!data.access_token) throw Object.assign(new Error('no token'), { status: 401, error: 'invalid_grant' });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ ok: true, user: data.user || claimsToUser(userAuth.verify(data.access_token)) });
        } catch (err) {
            if (err.status && err.status < 500) return res.status(401).json({ error: err.error || 'invalid_grant' });
            return res.status(502).json({ error: 'server_error', error_description: 'Could not reach OpenVibe.Network' });
        }
    });

    router.get('/logout', async (req, res) => {
        const refresh = req.cookies && req.cookies[REFRESH_COOKIE];
        if (refresh) {
            try {
                await fetchImpl(`${config.network.internalUrl}/oauth/revoke`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ client_id: config.oauth.clientId, client_secret: config.oauth.clientSecret, token: refresh }),
                    signal: AbortSignal.timeout(3000),
                });
            } catch { /* optional */ }
        }
        clearSession(res);
        res.cookie(HINT_COOKIE, 'guest', hintOpts());
        res.redirect(sanitizeNext(req.query.next, config));
    });

    router.get('/me', (req, res) => {
        const token = (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) || (req.cookies && req.cookies[ACCESS_COOKIE]);
        const claims = userAuth.verify(token);
        if (!claims) return res.status(401).json({ error: 'Not authenticated' });
        res.json({ user: claimsToUser(claims), expires_at: claims.exp ? claims.exp * 1000 : null });
    });

    router.post('/refresh', async (req, res) => {
        const refresh = req.cookies && req.cookies[REFRESH_COOKIE];
        if (!refresh) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: refresh });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ token: data.access_token, user: claimsToUser(userAuth.verify(data.access_token)) });
        } catch (err) {
            if (err.status && err.status < 500) { clearSession(res); return res.status(401).json({ error: 'Refresh token rejected — please sign in again' }); }
            return res.status(502).json({ error: 'Could not reach OpenVibe.Network' });
        }
    });

    return router;
}

module.exports = { createSessionRoutes, viewerMiddleware, sanitizeNext, ACCESS_COOKIE };
