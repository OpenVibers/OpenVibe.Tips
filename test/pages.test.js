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
        // The home opens with the showcase kit (openvibe-shared/showcase): one h1 (the hero), the kit's sheet, the
        // pricing from the real defaults, and the creators list still below it.
        assert.ok(r.text.includes('class="sc-hero') && r.text.includes('class="sc-tiers"'), 'hero and pricing');
        assert.match(r.text, /<link rel="stylesheet" href="\/shared\/showcase\.css\?v=[^"]+">/);
        assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
        assert.ok(r.text.indexOf('class="sc-hero') < r.text.indexOf('id="creators"'), 'the creators follow the showcase');
        assert.ok(!(await get('/alex')).text.includes('showcase.css'), 'only the home links the kit');
    });

    await check('the home quotes the minimums a new page really starts with (the migration defaults)', () => {
        const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'migrations', '0001_initial.sql'), 'utf8');
        const def = (col) => Number((sql.match(new RegExp(`\\b${col}\\s+bigint NOT NULL DEFAULT (\\d+)`)) || [])[1]);
        const { NEW_PAGE_MINIMUMS: m } = require('../server/web/pages');
        assert.deepStrictEqual(m, { tip: def('min_amount'), paid_message: def('paid_message_min'), tts: def('tts_min_amount'), media_request: def('media_request_min') });
    });

    await check('every page carries the boost marker and script, and the navbar signs in back to the current page', async () => {
        for (const [p, u] of [['/', null], ['/alex', viewer], ['/dashboard', alex], ['/receipts', viewer], ['/updates', alex]]) {
            const r = await get(p, u);
            assert.strictEqual(r.status, 200, p);
            assert.match(r.text, /<meta name="ov-boost" content="tips@[^"]+">/, p);
            assert.match(r.text, /<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/, p);
            assert.match(r.text, /"loginUrl":"\/auth\/login\?next=\{path\}"/, p);
        }
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

    await check('the head comes from openvibe-shared/shell and keeps every tag and script of the site', async () => {
        const home = await get('/');
        const head = home.text.slice(0, home.text.indexOf('</head>'));
        assert.strictEqual(head.match(/<title>/g).length, 1, 'exactly one <title>');
        assert.match(head, /<title>OpenVibe\.Tips — support the creators you watch<\/title>/);
        assert.match(head, /<link rel="canonical" href="http:\/\/tips\.test\/">/);
        assert.match(head, /<meta name="robots" content="index,follow">/);
        assert.match(head, /<meta property="og:title" content="OpenVibe\.Tips — support the creators you watch">/);
        assert.match(head, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
        assert.match(head, /<link rel="stylesheet" href="\/css\/tips\.css\?v=[^"]+">/);
        assert.match(head, /<link rel="icon"[^>]*data-ov-icon="tips"/, 'the app-icon tags');
        assert.match(head, /<meta name="ov-release"/);
        assert.match(head, /<meta name="ov-boost" content="tips@[^"]+">/);
        assert.match(head, /<script src="\/shared\/boost\.js\?v=[0-9a-f]{12}" data-main="#main" defer><\/script>/);
        assert.match(head, /<script src="\/js\/tips\.js\?v=[^"]+" defer><\/script>/);
        for (const s of ['theme-loader', 'navbar', 'footer']) assert.match(head, new RegExp(`/shared/${s}\\.js\\?v=[0-9a-f]{12}`), s);
        assert.match(home.text, /<body data-page="home">/);
        assert.match(home.text, /<header class="site-head">/);
        assert.match(home.text, /<main id="main" class="page">/);
        assert.match(home.text, /OpenVibeFooter\.init\(window\.__OV_PAGE\.footer\)/);

        const creator = await get('/alex');
        const creatorHead = creator.text.slice(0, creator.text.indexOf('</head>'));
        assert.match(creatorHead, /<link rel="canonical" href="http:\/\/tips\.test\/alex">/);
        assert.match(creatorHead, /<script type="application\/ld\+json">\{[^<]*"@type":"ProfilePage"/);
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

    await check('robots.txt, sitemap.xml and llms.txt: the shared seo kit, listing only switched-on pages', async () => {
        const robots = await get('/robots.txt');
        assert.strictEqual(robots.status, 200);
        assert.match(robots.headers.get('content-type'), /^text\/plain/);
        assert.match(robots.text, /^Allow: \/$/m);
        for (const path of ['/dashboard', '/receipts', '/overlay/', '/moderate/', '/auth/', '/api/', '/internal/']) {
            assert.ok(robots.text.includes(`Disallow: ${path}\n`), `robots keeps ${path} private`);
        }
        assert.match(robots.text, /Sitemap: http:\/\/tips\.test\/sitemap\.xml\n/, 'robots names the sitemap');
        const sm = await get('/sitemap.xml');
        assert.strictEqual(sm.status, 200);
        assert.match(sm.headers.get('content-type'), /^application\/xml/);
        assert.match(sm.text, /<loc>http:\/\/tips\.test\/<\/loc>/, 'the sitemap lists the home URL');
        assert.match(sm.text, /<loc>http:\/\/tips\.test\/alex<\/loc>/);
        assert.match(sm.text, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, 'every url carries a real lastmod');
        assert.ok(!sm.text.includes('/bob<'));
        const llms = await get('/llms.txt');
        assert.strictEqual(llms.status, 200);
        assert.match(llms.headers.get('content-type'), /^text\/plain/);
        assert.match(llms.text, /^# /, 'llms.txt starts with a markdown heading');
        assert.match(llms.text, /\[Creators on OpenVibe\.Tips\]\(http:\/\/tips\.test\/\)/, 'llms.txt lists the main public pages');
        assert.match(llms.text, /\[llms-full\.txt\]\(http:\/\/tips\.test\/llms-full\.txt\)/, 'llms.txt points at llms-full.txt');
        const full = await get('/llms-full.txt');
        assert.strictEqual(full.status, 200);
        assert.match(full.headers.get('content-type'), /^text\/plain/);
        assert.match(full.text, /^# /, 'llms-full.txt starts with the same markdown heading');
        assert.match(full.text, /URL: http:\/\/tips\.test\/\n/, 'llms-full.txt contains the home URL');
        assert.match(full.text, /URL: http:\/\/tips\.test\/alex\n/, 'llms-full.txt contains the switched-on creator page');
        assert.ok(!full.text.includes('/bob'), 'llms-full.txt never lists a switched-off page');
        assert.ok(!/(?:URL: http:\/\/tips\.test\/)(?:dashboard|receipts|overlay|moderate|auth|api)/.test(full.text), 'llms-full.txt lists no signed-in page');
        assert.ok(Buffer.byteLength(full.text) < 512 * 1024, 'llms-full.txt stays under 512 KiB');
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
        assert.strictEqual((await domain.interactions.get(t.db, id)).payment_state, 'settled');
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
        assert.strictEqual((await domain.profiles.byHandle(t.db, 'alex')).page_enabled, true);
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
        assert.strictEqual(await t.db.value('SELECT count(*) FROM tip_interactions WHERE creator_subject = $1 AND test', [alex.subject]), 1);
        const off = await post('/dashboard/profile', alex, { csrf, idem: 'x', accepting: '1', revision: String((await domain.profiles.byHandle(t.db, 'alex')).revision) });
        assert.strictEqual(off.status, 303);
        assert.strictEqual((await domain.profiles.byHandle(t.db, 'alex')).page_enabled, false, 'an unchecked box switches the page off');
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
