'use strict';
// A creator's tip page in one step (plan C4, 10-22: production had one profile because Live's streamers never came
// here). OpenVibe.Live's dashboard links to /start: signed in, the page is made from the account and one button turns
// it on; a page that is on already goes to the dashboard; the form needs this site's anti-forgery field.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const sam = t.network.newUser('sam');
    const cookie = (u) => `ov_token=${t.network.signUser(u)}`;
    const req = async (method, p, u, body) => {
        const headers = u ? { Cookie: cookie(u) } : {};
        if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const r = await fetch(t.base + p, { method, headers, body: body ? new URLSearchParams(body).toString() : undefined, redirect: 'manual' });
        return { status: r.status, location: r.headers.get('location'), text: await r.text() };
    };
    const field = (html, name) => { const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`)); return m ? m[1] : null; };

    await check('signed out, /start asks for sign-in and comes back to it', async () => {
        const r = await req('GET', '/start');
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.location, '/auth/login?next=%2Fstart');
    });

    await check('signed in, /start says what the page will be; nothing is public until the button', async () => {
        const r = await req('GET', '/start', sam);
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /openvibe\.tips\/sam/);
        assert.match(r.text, /Turn on my tip page/);
        assert.match(r.text, /noindex/);
        assert.strictEqual((await req('GET', '/sam')).status, 404, 'the page is off until the creator turns it on');
    });

    await check('a form without this site\'s anti-forgery field changes nothing', async () => {
        const r = await req('POST', '/start', sam, { csrf: 'forged' });
        assert.strictEqual(r.status, 403);
        assert.strictEqual((await req('GET', '/sam')).status, 404);
    });

    await check('the button turns the page on, accepting tips, and opens the dashboard', async () => {
        const page = await req('GET', '/start', sam);
        const r = await req('POST', '/start', sam, { csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem') });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.location, `/dashboard?done=${encodeURIComponent('Your tip page is on')}`);
        const dash = await req('GET', r.location, sam);
        assert.match(dash.text, /Your tip page is on/);
        const pub = await req('GET', '/sam');
        assert.strictEqual(pub.status, 200);
        const api = await t.call('GET', '/api/v1/profiles/sam', { token: null });
        assert.deepStrictEqual([api.json.profile.page_enabled, api.json.profile.accepting], [true, true]);
    });

    await check('once the page is on, /start goes to the dashboard; "start" is never a creator\'s handle', async () => {
        const r = await req('GET', '/start', sam);
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.location, '/dashboard');
        const { normalizeHandle } = require('../server/domain/profiles');
        assert.strictEqual(normalizeHandle('start'), null);
    });

    await t.close();
    done();
})();
