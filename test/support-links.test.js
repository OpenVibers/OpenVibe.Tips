'use strict';
// Other ways to support a creator, paid outside OpenVibe (owner 10-08: Billing is provider agnostic; creators bring
// Ko-fi, PayPal.me, Patreon and other links). A link is a known service plus the creator's handle, and Tips builds the
// URL: a pasted link counts only on that service's own host, so no look-alike page can be stored.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const links = require('../server/domain/support-links');

(async () => {
    await check('a handle or the link on that service; any other host or a bad name is refused', async () => {
        assert.strictEqual(links.handleOf('kofi', 'tierra_tv'), 'tierra_tv');
        assert.strictEqual(links.handleOf('kofi', 'https://ko-fi.com/tierra_tv'), 'tierra_tv');
        assert.strictEqual(links.handleOf('kofi', 'ko-fi.com/tierra_tv/'), 'tierra_tv');
        assert.strictEqual(links.handleOf('kofi', 'https://ko-fi.com.evil.example/tierra'), undefined, 'a look-alike host');
        assert.strictEqual(links.handleOf('kofi', 'https://evil.example/ko-fi.com/tierra'), undefined);
        assert.strictEqual(links.handleOf('paypal', 'https://www.paypal.com/paypalme/Tierra'), 'Tierra');
        assert.strictEqual(links.handleOf('cashapp', '$tierra'), 'tierra');
        assert.strictEqual(links.handleOf('cashapp', 'https://cash.app/$tierra'), 'tierra');
        assert.strictEqual(links.handleOf('github', 'https://github.com/sponsors/tierra'), 'tierra');
        assert.strictEqual(links.handleOf('github', 'https://github.com/tierra'), undefined, 'only the Sponsors page');
        assert.strictEqual(links.handleOf('streamlabs', 'streamlabs.com/tierra/tip'), 'tierra');
        assert.strictEqual(links.handleOf('patreon', 'javascript:alert(1)'), undefined);
        assert.strictEqual(links.handleOf('kofi', '   '), null, 'blank means no link');
        assert.deepStrictEqual(links.present([{ provider: 'kofi', handle: 'x"><script>' }, { provider: 'myspace', handle: 'a' }, { provider: 'liberapay', handle: 'tierra' }]),
            [{ provider: 'liberapay', label: 'Liberapay', handle: 'tierra', url: 'https://liberapay.com/tierra' }], 'stored rows that are not valid are never shown');
    });

    const t = await boot();
    const tierra = await t.creator('tierra');
    const viewer = t.network.newUser('viewer');
    const cookie = (u) => `ov_token=${t.network.signUser(u)}`;
    const get = async (p, u) => { const r = await fetch(t.base + p, { headers: u ? { Cookie: cookie(u) } : {}, redirect: 'manual' }); return { status: r.status, text: await r.text() }; };
    const field = (html, name) => { const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`)); return m ? m[1] : null; };

    await check('the API sets them (a pasted link becomes the handle); the public profile carries the links Tips built', async () => {
        const r = await t.call('PATCH', '/api/v1/profiles/me', { user: tierra, body: { support_links: [{ provider: 'kofi', handle: 'https://ko-fi.com/tierra_tv' }, { provider: 'paypal', handle: 'TierraTV' }] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.profile.support_links, [
            { provider: 'kofi', label: 'Ko-fi', handle: 'tierra_tv', url: 'https://ko-fi.com/tierra_tv' },
            { provider: 'paypal', label: 'PayPal.me', handle: 'TierraTV', url: 'https://paypal.me/TierraTV' },
        ]);
        const pub = await t.call('GET', '/api/v1/profiles/tierra', { token: null });
        assert.strictEqual(pub.json.profile.support_links.length, 2);
        const bad = await t.call('PATCH', '/api/v1/profiles/me', { user: tierra, body: { support_links: [{ provider: 'kofi', handle: 'https://k0-fi.com/tierra' }] } });
        assert.strictEqual(bad.status, 422);
        const twice = await t.call('PATCH', '/api/v1/profiles/me', { user: tierra, body: { support_links: [{ provider: 'kofi', handle: 'a1' }, { provider: 'kofi', handle: 'b2' }] } });
        assert.strictEqual(twice.status, 422);
        const other = await t.call('PATCH', '/api/v1/profiles/tierra', { user: viewer, body: { support_links: [] } });
        assert.strictEqual(other.status, 403, 'only the creator (or a granted service) changes them');
    });

    await check('the tip page lists them as paid outside OpenVibe, nofollow and in a new tab', async () => {
        const page = await get('/tierra');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Other ways to support/);
        assert.match(page.text, /<a class="btn ghost" href="https:\/\/ko-fi\.com\/tierra_tv" rel="nofollow noopener ugc" target="_blank">Ko-fi<\/a>/);
        assert.match(page.text, /paid outside OpenVibe: OpenVibe never sees or holds them/);
    });

    await check('the dashboard form saves one field per service; blank ones are removed', async () => {
        const d = await get('/dashboard', tierra);
        assert.match(d.text, /id="support-links"/);
        assert.match(d.text, /name="link_kofi"[^>]*value="tierra_tv"/);
        const body = new URLSearchParams({ csrf: field(d.text, 'csrf'), idem: `sl-${Date.now()}`, link_kofi: '', link_patreon: 'https://www.patreon.com/tierra', link_cashapp: '$tierra' });
        const r = await fetch(`${t.base}/dashboard/support-links`, { method: 'POST', body, redirect: 'manual', headers: { Cookie: cookie(tierra), 'Content-Type': 'application/x-www-form-urlencoded' } });
        const txt = await r.text();
        assert.strictEqual(r.status, 303, (/class="error[^"]*"[^>]*>([\s\S]{0,200})/.exec(txt) || [])[1] || String(r.status));
        const pub = await t.call('GET', '/api/v1/profiles/tierra', { token: null });
        assert.deepStrictEqual(pub.json.profile.support_links.map((l) => l.url), ['https://www.patreon.com/tierra', 'https://cash.app/$tierra']);
    });

    await t.close();
    done();
})();
