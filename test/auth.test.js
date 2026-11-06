'use strict';
/**
 * The sign-in (openvibe-sdk/sso): the authorize URL carries PKCE S256, the flow cookies are the ones this site
 * has always used (ov_oauth_state, ov_oauth_next, ov_oauth_silent and the PKCE verifier in ov_oauth_verifier),
 * the state is compared with the flow cookie in constant time, next is sanitized at the login and at the
 * callback, and GET /auth/health is 503 only when the Network refuses this site's OAuth client.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const get = (p, headers = {}) => fetch(t.base + p, { redirect: 'manual', headers });
    const cookies = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
    const cookieHeader = (res) => cookies(res).join('; ');
    const flow = (res, name) => res.headers.getSetCookie().find((c) => c.startsWith(name + '=')) || '';

    await check('the sign-in starts at the Network with PKCE S256 and the flow cookies this site has always used', async () => {
        const res = await get('/auth/login?next=%2Fstart');
        assert.strictEqual(res.status, 302);
        const u = new URL(res.headers.get('location'));
        assert.deepStrictEqual([u.pathname, u.searchParams.get('client_id'), u.searchParams.get('redirect_uri'), u.searchParams.get('response_type')],
            ['/oauth/authorize', 'tips', 'http://tips.test/auth/callback', 'code']);
        assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256', 'PKCE S256 from openvibe-sdk/sso');
        const challenge = u.searchParams.get('code_challenge');
        assert.match(challenge, /^[A-Za-z0-9_-]{43}$/, 'the code challenge');
        const state = u.searchParams.get('state');
        assert.ok(state && state.length >= 16, 'the state');
        assert.match(flow(res, 'ov_oauth_state'), new RegExp('^ov_oauth_state=' + state));
        assert.match(flow(res, 'ov_oauth_verifier'), /Path=\/auth/i, 'the verifier stays in a flow cookie of its own');
        // express encodes the cookie's value: the path arrives percent-encoded.
        const nextCookie = flow(res, 'ov_oauth_next').split(';')[0].split('=')[1];
        assert.strictEqual(decodeURIComponent(nextCookie), '/start');
        // The challenge is the SHA-256 of the verifier in the cookie: the Network checks exactly that.
        const verifier = flow(res, 'ov_oauth_verifier').split(';')[0].split('=')[1];
        assert.strictEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
    });

    await check('a callback whose state does not match the flow cookie is refused, and no session is set', async () => {
        const started = await get('/auth/login');
        const res = await get('/auth/callback?code=whatever&state=not-the-state', { Cookie: cookieHeader(started) });
        assert.strictEqual(res.status, 400);
        assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('ov_token=')), 'no session');
    });

    await check('a callback without the verifier cookie is refused too (the code could not be exchanged)', async () => {
        const started = await get('/auth/login');
        const u = new URL(started.headers.get('location'));
        const without = cookies(started).filter((c) => !c.startsWith('ov_oauth_verifier=')).join('; ');
        const res = await get('/auth/callback?code=whatever&state=' + encodeURIComponent(u.searchParams.get('state')), { Cookie: without });
        assert.strictEqual(res.status, 400);
        assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('ov_token=')), 'no session');
    });

    await check('a sign-in with a code the Network issued sets the session and returns to next', async () => {
        const started = await get('/auth/login?next=%2Fstart');
        const u = new URL(started.headers.get('location'));
        const code = t.network.issueCode();
        const res = await get('/auth/callback?code=' + code + '&state=' + encodeURIComponent(u.searchParams.get('state')), { Cookie: cookieHeader(started) });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/start');
        const set = res.headers.getSetCookie();
        assert.ok(set.some((c) => c.startsWith('ov_token=')), 'the session cookie, with the name this site has always used');
        assert.ok(set.some((c) => c.startsWith('ov_refresh=')), 'the refresh cookie');
    });

    await check('next is sanitized: off-site never, neither at the login nor at the callback', async () => {
        const started = await get('/auth/login?next=https%3A%2F%2Fevil.com%2Fx');
        const offSite = flow(started, 'ov_oauth_next').split(';')[0].split('=')[1];
        assert.ok(!offSite, 'an off-site next is not kept');
        const again = await get('/auth/login');
        const u = new URL(again.headers.get('location'));
        const code = t.network.issueCode();
        const res = await get('/auth/callback?code=' + code + '&state=' + encodeURIComponent(u.searchParams.get('state')),
            { Cookie: cookieHeader(again) + '; ov_oauth_next=//evil.com/x' });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/', 'a tampered next goes home');
    });

    await check('GET /auth/health: 200 while the Network accepts this client', async () => {
        const res = await get('/auth/health');
        assert.strictEqual(res.status, 200);
        const json = await res.json();
        assert.deepStrictEqual([json.ok, json.client], [true, 'ok']);
    });

    const broken = await boot({ env: { OV_OAUTH_CLIENT_SECRET: 'not-the-secret' } });
    await check('a client the Network refuses is a 503, and only then', async () => {
        const res = await fetch(broken.base + '/auth/health', { redirect: 'manual' });
        assert.strictEqual(res.status, 503);
        const json = await res.json();
        assert.deepStrictEqual([json.ok, json.client], [false, 'invalid']);
    });
    await broken.close();

    await t.close();
    done();
})();
