'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file answers at /<key>.txt as text/plain and a creator's public page
 * appearing or changing pings its URL and the sitemap. A switched-off page never pings, and the
 * crawler map (/llms.txt, /llms-full.txt) is untouched by the feature either way.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const KEY = 'k'.repeat(32);

(async () => {
    const off = await boot();
    await check('without a key IndexNow is off: the key route 404s and the maps still answer', async () => {
        assert.strictEqual(off.app.locals.indexnow.enabled, false);
        const res = await off.call('GET', `/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
        assert.strictEqual((await off.call('GET', '/llms.txt')).status, 200);
        assert.strictEqual((await off.call('GET', '/llms-full.txt')).status, 200);
    });
    await off.close();

    const on = await boot({ env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers /<key>.txt as text/plain, and the maps still answer', async () => {
        assert.strictEqual(on.app.locals.indexnow.enabled, true);
        const res = await on.call('GET', `/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
        assert.strictEqual((await on.call('GET', '/llms.txt')).status, 200);
        assert.strictEqual((await on.call('GET', '/llms-full.txt')).status, 200);
    });
    await on.close();

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
    };
    const t = await boot({ appOpts: { indexnow: spy } });
    let alex;

    await check('switching a creator page on pings its URL and the sitemap', async () => {
        alex = await t.creator('alex', { settings: { headline: 'Late-night synth streams' } });
        assert.ok(pings.includes('http://tips.test/alex'), JSON.stringify(pings));
        assert.ok(pings.includes('http://tips.test/sitemap.xml'), JSON.stringify(pings));
    });

    await check('changing a public page pings again', async () => {
        pings.length = 0;
        const r = await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { headline: 'Now with text-to-speech' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(pings.includes('http://tips.test/alex'), JSON.stringify(pings));
        assert.ok(pings.includes('http://tips.test/sitemap.xml'), JSON.stringify(pings));
    });

    await check('a switched-off page never pings', async () => {
        pings.length = 0;
        await t.creator('bob', { settings: { page_enabled: false } });
        assert.ok(!pings.some((u) => u.includes('/bob')), JSON.stringify(pings));
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
