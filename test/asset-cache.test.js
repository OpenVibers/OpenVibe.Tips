'use strict';
// Cache-Control comes from openvibe-shared/cache-policy, not from a literal per route: a versioned
// asset is immutable for a year, any other asset is a five-minute window with a day of
// stale-while-revalidate, and the machine-readable pages get the shared html policy.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const cache = require('openvibe-shared/cache-policy');
const { assetVersion } = require('../server/web/layout');

(async () => {
    const t = await boot();
    const get = async (p) => { const r = await fetch(t.base + p, { redirect: 'manual' }); return { status: r.status, headers: r.headers, text: await r.text() }; };

    await check('static assets: immutable only under their own ?v=<version>, short-lived otherwise', async () => {
        const rel = 'css/overlay.css';
        const good = await get(`/${rel}?v=${assetVersion(rel)}`);
        assert.strictEqual(good.status, 200);
        assert.strictEqual(good.headers.get('cache-control'), cache.IMMUTABLE);
        const wrong = await get(`/${rel}?v=deadbeefdeadbeef`);
        assert.strictEqual(wrong.status, 200);
        assert.strictEqual(wrong.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
        const bare = await get(`/${rel}`);
        assert.strictEqual(bare.status, 200);
        assert.strictEqual(bare.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
    });

    await check('robots.txt: the shared html policy at the same window', async () => {
        const r = await get('/robots.txt');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('cache-control'), cache.htmlHeaders({ maxAge: 3600 }));
    });

    await done();
})();
