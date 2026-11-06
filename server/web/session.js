'use strict';

/**
 * openvibe.tips — OAuth2 client session layer (identity provider: OpenVibe.Network), the same
 * shape as OpenVibe.Community's server/auth/routes.js. Registered in the Network as client `tips`
 * with redirect https://openvibe.tips/auth/callback.
 *
 * The OAuth half is openvibe-sdk/sso's (createSsoClient): the authorize URL, the PKCE S256 pair (new
 * here: this copied layer had none), the code, refresh and FedCM grants and the new GET /auth/health.
 * The state is compared with the flow cookie in constant time, next is still sanitized by this repo's
 * sanitizer, the viewer resolver and every permission check are untouched, and the redirect URI is
 * unchanged.
 *
 *   GET  /auth/login     → Network /oauth/authorize (?silent=1 → prompt=none; ?next= same-site path)
 *   GET  /auth/callback  → server-side code exchange with the PKCE verifier, session cookies
 *   POST /auth/fedcm     → the shared navbar's FedCM assertion → tokens (jwt-bearer grant)
 *   GET  /auth/health    → does the Network accept this OAuth client? 503 only when it refuses it
 *   GET  /auth/logout    → clear cookies (best-effort refresh revoke), hint=guest
 *   GET  /auth/me        → the signed-in user (offline JWT verification)
 *   POST /auth/refresh   → rotate tokens
 *
 * Cookies (host-only, the names this site has always used): ov_token (access JWT, Lax, JS-readable for the navbar),
 * ov_refresh (httpOnly, Path=/auth), ov_sso_hint. These cookies only ever sign a person into the pages of this site;
 * overlays never use them (overlays hold their own revocable tokens). The short-lived flow cookies on /auth are
 * ov_oauth_state, ov_oauth_next, ov_oauth_silent plus the PKCE verifier in ov_oauth_verifier.
 */
const express = require('express');
const crypto = require('crypto');
const { createSsoClient, failurePage } = require('openvibe-sdk/sso');
const { userPrincipal } = require('../api/auth');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const HINT_COOKIE = 'ov_sso_hint';
const STATE_COOKIE = 'ov_oauth_state';
const VERIFIER_COOKIE = 'ov_oauth_verifier';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';
const SITE_NAME = 'OpenVibe.Tips';

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
    // Browsers drop tab and newline characters from a URL and read a backslash as "/": "/<TAB>/evil.com" would
    // leave the site. A next with any control character or backslash goes home.
    if (typeof next === 'string' && /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
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

/** Compare two strings in constant time (the state must match the browser that started the flow). */
function sameString(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** Page middleware: req.viewer = the signed-in person (principal shape) or null. Never blocks. */
function viewerMiddleware(userAuth) {
    return async (req, _res, next) => {
        const token = req.cookies && req.cookies[ACCESS_COOKIE];
        const claims = token ? await userAuth.verify(token) : null;
        req.viewer = claims ? userPrincipal(claims) : null;
        req.viewerClaims = claims ? claimsToUser(claims) : null;
        next();
    };
}

function createSessionRoutes(config, userAuth, { fetchImpl = globalThis.fetch, log = console } = {}) {
    const router = express.Router();
    const secure = config.cookies.secure;
    // The OAuth half is the SDK's: the authorize URL, the PKCE S256 pair, the token grants and the health check.
    const sdkSso = createSsoClient({
        site: 'tips',
        siteName: SITE_NAME,
        baseUrl: config.baseUrl,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        scope: config.oauth.scope,
        networkUrl: config.network.url,
        networkInternalUrl: config.network.internalUrl,
        issuer: config.network.issuer,
        secureCookies: secure,
        fetch: fetchImpl,
        log,
    });
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
    function clearFlow(res) { for (const c of [STATE_COOKIE, VERIFIER_COOKIE, NEXT_COOKIE, SILENT_COOKIE]) res.clearCookie(c, { path: '/auth' }); }

    router.get('/login', async (req, res) => {
        const silent = !!req.query.silent && req.query.silent !== '0';
        if (silent && await userAuth.verify(req.cookies && req.cookies[ACCESS_COOKIE])) { clearFlow(res); return res.redirect(sanitizeNext(req.query.next, config)); }
        const started = sdkSso.authorizeUrl({ silent });
        res.cookie(STATE_COOKIE, started.state, flowOpts());
        res.cookie(VERIFIER_COOKIE, started.verifier, flowOpts());
        const next = sanitizeNext(req.query.next, config);
        if (next !== '/') res.cookie(NEXT_COOKIE, next, flowOpts()); else res.clearCookie(NEXT_COOKIE, { path: '/auth' });
        if (silent) res.cookie(SILENT_COOKIE, '1', flowOpts()); else res.clearCookie(SILENT_COOKIE, { path: '/auth' });
        res.redirect(started.url);
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
        const verifier = req.cookies && req.cookies[VERIFIER_COOKIE];
        clearFlow(res);
        if (!verifier || !sameString(state, expected)) {
            return res.status(400).type('text/plain').send('Sign-in state mismatch — please try signing in again.');
        }
        try {
            const data = await sdkSso.tokenGrant({ grant_type: 'authorization_code', redirect_uri: config.oauth.redirectUri, code: String(code), code_verifier: verifier });
            setSession(res, data.access_token, data.refresh_token);
            return res.redirect(next);
        } catch (err) {
            if (err.status === 401 || err.error === 'invalid_client' || err.error === 'unauthorized_client') {
                log.error(`[Tips] the Network refuses this site's OAuth client (${err.error || err.status}): check OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET`);
                return res.status(500).type('html').send(failurePage({
                    siteName: SITE_NAME,
                    title: 'Sign-in isn\'t working on OpenVibe.Bot right now',
                    text: 'This is a problem on our side, not with your account, and it has been logged. Please try again a little later.',
                    retryHref: `/auth/login?next=${encodeURIComponent(next)}`,
                    backHref: next || '/',
                }));
            }
            log.error(`[Tips] code exchange failed: ${err.message}`);
            return res.status(502).type('text/plain').send('Sign-in failed — could not reach OpenVibe.Network. Please try again.');
        }
    });

    // GET /auth/health: does the Network accept this OAuth client? 503 only when it refuses it.
    router.get('/health', async (_req, res) => {
        const client = await sdkSso.checkClient();
        res.set('Cache-Control', 'no-store');
        return res.status(client === 'invalid' ? 503 : 200).json({ ok: client !== 'invalid', client });
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
            const data = await sdkSso.tokenGrant({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: token });
            if (!data.access_token) throw Object.assign(new Error('no token'), { status: 401, error: 'invalid_grant' });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ ok: true, user: data.user || claimsToUser(await userAuth.verify(data.access_token)) });
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

    router.get('/me', async (req, res) => {
        const token = (String(req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) || (req.cookies && req.cookies[ACCESS_COOKIE]);
        const claims = await userAuth.verify(token);
        if (!claims) return res.json({ user: null });   // signed out: 200 with no user (as Blog, Community, Wiki), not a 401 in every signed-out visitor's console
        res.json({ user: claimsToUser(claims), expires_at: claims.exp ? claims.exp * 1000 : null });
    });

    router.post('/refresh', async (req, res) => {
        const refresh = req.cookies && req.cookies[REFRESH_COOKIE];
        if (!refresh) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await sdkSso.tokenGrant({ grant_type: 'refresh_token', refresh_token: refresh });
            setSession(res, data.access_token, data.refresh_token);
            return res.json({ token: data.access_token, user: claimsToUser(await userAuth.verify(data.access_token)) });
        } catch (err) {
            if (err.status && err.status < 500) { clearSession(res); return res.status(401).json({ error: 'Refresh token rejected — please sign in again' }); }
            return res.status(502).json({ error: 'Could not reach OpenVibe.Network' });
        }
    });

    return router;
}

module.exports = { createSessionRoutes, viewerMiddleware, sanitizeNext, ACCESS_COOKIE };
