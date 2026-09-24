'use strict';
// Server-rendered pages: useful without JavaScript, indexable only when the creator switched the
// page on, forms protected against cross-site posts, and the copy rules.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const { billing, domain } = t;
    const alex = await t.creator('alex', { settings: { headline: 'Late-night synth streams', tts_enabled: true } });
    const bob = await t.creator('bob', { settings: { page_enabled: false } });
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 1000);
    await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'New synth', target_amount: 5000 } });

    const cookie = (u) => `ov_token=${t.network.signUser(u)}`;
    const get = async (p, u) => { const r = await fetch(t.base + p, { headers: u ? { Cookie: cookie(u) } : {}, redirect: 'manual' }); return { status: r.status, headers: r.headers, text: await r.text() }; };
    const post = async (p, u, form) => {
        const r = await fetch(t.base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(u ? { Cookie: cookie(u) } : {}) }, body: new URLSearchParams(form).toString() });
        return { status: r.status, headers: r.headers, text: await r.text() };
    };
    const field = (html, name) => { const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`)); return m ? m[1] : null; };
    const COPY = /\bfree\b|\$0\b|no ads/i;

    await check('home: server-rendered with the shared chrome, a noscript nav and the release meta', async () => {
        const r = await get('/');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<noscript><nav/);
        assert.match(r.text, /\/shared\/navbar\.js\?v=[0-9a-f]{12}/);
        assert.match(r.text, /<meta name="ov-release"/);
        assert.match(r.text, /id="ov-footer"|class="ovf/);
        assert.match(r.text, /href="\/alex"/);
        assert.ok(!r.text.includes('href="/bob"'), 'switched-off pages are not listed');
    });

    await check('creator page: indexable when on, goals and a no-JS tip form', async () => {
        const r = await get('/alex');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /<meta name="robots" content="index,follow">/);
        assert.match(r.text, /<link rel="canonical" href="http:\/\/tips\.test\/alex">/);
        assert.match(r.text, /New synth/);
        assert.match(r.text, /<form class="card tip-form" method="post" action="\/alex\/tip">/);
        assert.match(r.text, /Sign in to send/);
        assert.match(r.text, /Late-night synth streams/);
        assert.match(r.text, /"@type":"ProfilePage"/);
        assert.match((await get('/@alex')).headers.get('location') || '', /\/alex$/);
    });

    await check('a switched-off page: 404 + noindex for everyone else; a noindex preview for its creator', async () => {
        const anon = await get('/bob');
        assert.strictEqual(anon.status, 404);
        assert.match(anon.text, /noindex/);
        const other = await get('/bob', viewer);
        assert.strictEqual(other.status, 404);
        const own = await get('/bob', bob);
        assert.strictEqual(own.status, 200);
        assert.match(own.text, /<meta name="robots" content="noindex,nofollow">/);
        assert.match(own.headers.get('x-robots-tag'), /noindex/);
        assert.match(own.text, /Your page is switched off/);
    });

    await check('robots.txt and sitemap.xml list only switched-on pages', async () => {
        const robots = await get('/robots.txt');
        assert.match(robots.text, /Disallow: \/dashboard/);
        assert.match(robots.text, /Disallow: \/overlay\//);
        const sm = await get('/sitemap.xml');
        assert.match(sm.text, /<loc>http:\/\/tips\.test\/alex<\/loc>/);
        assert.ok(!sm.text.includes('/bob<'));
    });

    await check('tipping without JavaScript: sign-in first, then a form post settles and lands on the receipt', async () => {
        const anon = await post('/alex/tip', null, { amount: '10' });
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.get('location'), /^\/auth\/login\?next=%2Falex/);
        const page = await get('/alex', viewer);
        const csrf = field(page.text, 'csrf');
        const idem = field(page.text, 'idem');
        assert.ok(csrf && idem);
        const form = { csrf, idem, kind: 'tip', amount: '25', message: 'no js needed', pay_with: 'credit', supporter_name: 'Viewer' };
        const r = await post('/alex/tip', viewer, form);
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const loc = r.headers.get('location');
        assert.match(loc, /^\/receipts\/tint_/);
        const id = loc.split('/').pop();
        assert.strictEqual(domain.interactions.get(id).payment_state, 'settled');
        // Double submit (same form nonce): the same interaction, no second transfer.
        const before = billing.transfers().length;
        const again = await post('/alex/tip', viewer, form);
        assert.strictEqual(again.headers.get('location'), loc);
        assert.strictEqual(billing.transfers().length, before);
        const receipt = await get(loc, viewer);
        assert.strictEqual(receipt.status, 200);
        assert.match(receipt.text, /Paid/);
        assert.match(receipt.text, /no js needed/);
        assert.match(receipt.text, /noindex/);
        assert.strictEqual((await get(loc, bob)).status, 404, 'someone else\'s receipt');
        const list = await get('/receipts', viewer);
        assert.match(list.text, new RegExp(id));
    });

    await check('a forged cross-site form (no valid token) is refused', async () => {
        const r = await post('/alex/tip', viewer, { csrf: 'forged', idem: 'form-abcdefghijkl', amount: '10' });
        assert.strictEqual(r.status, 403);
        const other = await get('/alex', bob);
        const r2 = await post('/alex/tip', viewer, { csrf: field(other.text, 'csrf'), idem: 'form-abcdefghijkm', amount: '10' });
        assert.strictEqual(r2.status, 403, 'a token minted for someone else does not work');
        const d = await post('/dashboard/profile', alex, { csrf: 'nope', page_enabled: '0' });
        assert.strictEqual(d.status, 403);
        assert.strictEqual(domain.profiles.byHandle('alex').page_enabled, true);
    });

    await check('the form reports Billing\'s refusal in words; checkout redirects to the provider', async () => {
        const page = await get('/alex', viewer);
        const low = await post('/alex/tip', viewer, { csrf: field(page.text, 'csrf'), idem: 'form-low-balance-1', amount: '99999', pay_with: 'credit' });
        assert.strictEqual(low.status, 409);
        assert.match(low.text, /balance is too low/);
        const co = await post('/alex/tip', viewer, { csrf: field(page.text, 'csrf'), idem: 'form-checkout-0001', amount: '200', pay_with: 'checkout', provider: 'stripe' });
        assert.strictEqual(co.status, 303);
        assert.match(co.headers.get('location'), /^https:\/\/checkout\.stripe\.test\//);
    });

    await check('dashboard: sign-in, settings, goals, a show-once overlay link, a simulation', async () => {
        assert.match((await get('/dashboard')).headers.get('location'), /^\/auth\/login/);
        const d = await get('/dashboard', alex);
        assert.strictEqual(d.status, 200);
        assert.match(d.text, /Creator dashboard/);
        assert.match(d.text, /noindex/);
        const csrf = field(d.text, 'csrf');
        const tok = await post('/dashboard/overlay-tokens', alex, { csrf, idem: 'x', label: 'Main', scope_alerts: '1', scope_goals: '1' });
        assert.strictEqual(tok.status, 201);
        assert.strictEqual(tok.headers.get('cache-control'), 'no-store');
        const url = tok.text.match(/value="(http:\/\/tips\.test\/overlay\/tovl_[^"]+)"/)[1];
        const secret = url.split('/').pop();
        assert.strictEqual((await fetch(`${t.base}/overlay/${secret}`)).status, 200);
        const d2 = await get('/dashboard', alex);
        assert.ok(!d2.text.includes(secret), 'the dashboard never shows it again');
        const g = await post('/dashboard/goals', alex, { csrf, idem: 'x', title: 'Second goal', target_amount: '300' });
        assert.strictEqual(g.status, 303);
        const sim = await post('/dashboard/simulate', alex, { csrf, idem: 'x', kind: 'tip', amount: '100', supporter_name: 'Test supporter', message: 'test' });
        assert.strictEqual(sim.status, 303);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM tip_interactions WHERE creator_subject = ? AND test = 1").get(alex.subject).n, 1);
        const off = await post('/dashboard/profile', alex, { csrf, idem: 'x', accepting: '1', revision: String(domain.profiles.byHandle('alex').revision) });
        assert.strictEqual(off.status, 303);
        assert.strictEqual(domain.profiles.byHandle('alex').page_enabled, false, 'an unchecked box switches the page off');
        assert.strictEqual((await get('/alex')).status, 404);
    });

    await check('copy rules: no pricing claims ("free", "$0", "no ads") on any page', async () => {
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { page_enabled: true } });
        for (const [p, u] of [['/', null], ['/alex', viewer], ['/alex/goals', null], ['/dashboard', alex], ['/receipts', viewer]]) {
            const r = await get(p, u);
            const visible = r.text.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
            assert.ok(!COPY.test(visible), `${p} has forbidden copy: ${(visible.match(COPY) || [])[0]}`);
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
