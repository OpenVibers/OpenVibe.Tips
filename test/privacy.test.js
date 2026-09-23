'use strict';
// Privacy: what a supporter lets the public see (anonymous, hidden amount, private message) holds in
// the API, overlays, chat lines, public pages and events; what the creator shows on the goals and
// supporters pages; a supporter's export and erasure of their own tips.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const registry = require('openvibe-contracts/lib/registry');
const { boot, check, done } = require('./helpers/app');

/** A payload validator for an event type: the released contract, else the proposal in docs/events-proposal/. */
function payloadValidator(type) {
    try { contracts.resolve(type); return (p) => contracts.validate(type, p); } catch { /* not released yet */ }
    const fn = registry.ajv.compile(require(`../docs/events-proposal/${type}.v1.json`));
    return (p) => ({ valid: fn(p), errors: fn.errors || [] });
}

(async () => {
    const t = await boot();
    const { domain, billing } = t;
    const alex = await t.creator('alex');
    const viewer = t.network.newUser('viewer');
    const other = t.network.newUser('other');
    billing.fund(viewer.subject, 50_000);
    billing.fund(other.subject, 50_000);
    const goal = (await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 100_000 } })).json.goal;
    const tok = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts', 'goals'] } });
    const secret = tok.json.secret;
    const tip = (user, body) => t.call('POST', '/api/v1/checkout', { user, body: { creator: 'alex', ...body } });
    const alertOf = async (id) => (await t.call('GET', `/overlay/${secret}/state`, { token: null })).json.alerts.find((a) => a.interaction_id === id);
    const jobsOf = (id) => t.adapters.test.jobs.filter((j) => j.interaction.id === id);
    const eventsOf = (type, id) => t.outboxRows(type).filter((e) => e.subject.id === id);

    let anonId;
    await check('anonymous: "Anonymous" to the creator, overlays, chat and events; the supporter keeps their receipt', async () => {
        const r = await tip(viewer, { amount: 120, message: 'from nobody', supporter_name: 'Viewer Real Name', privacy: { anonymous: true } });
        assert.strictEqual(r.status, 201, r.text);
        anonId = r.json.interaction.id;
        assert.strictEqual(r.json.interaction.supporter.id, viewer.subject, 'the supporter sees themselves');
        assert.strictEqual(r.json.interaction.supporter_name, 'Viewer Real Name');
        assert.deepStrictEqual(r.json.interaction.privacy, { anonymous: true, hide_amount: false, private_message: false });
        assert.strictEqual(r.json.interaction.public.supporter_name, 'Anonymous');

        const s = await t.sse(`/overlay/${secret}/events`);
        const a = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === anonId);
        s.close();
        assert.strictEqual(a.data.supporter_name, 'Anonymous');
        assert.strictEqual(a.data.message, 'from nobody');
        assert.ok(!JSON.stringify(a.data).includes('Viewer Real Name') && !JSON.stringify(a.data).includes(viewer.subject));
        const g = t.db.prepare("SELECT payload FROM overlay_deliveries WHERE kind = 'goal' AND interaction_id = ?").get(anonId);
        assert.strictEqual(JSON.parse(g.payload).by, 'Anonymous');

        await domain.effects.drain();
        const [job] = jobsOf(anonId);
        assert.deepStrictEqual(job.supporter, { name: 'Anonymous', subject: null });
        assert.strictEqual(job.text, 'Anonymous tipped 120 Vibes: from nobody');

        const [ready] = eventsOf('tips.interaction.ready', anonId);
        assert.strictEqual(ready.payload.supporter, null);
        assert.strictEqual(ready.payload.supporter_name, 'Anonymous');
        assert.ok(contracts.validate('tips.interaction.ready', ready.payload).valid);
        assert.ok(!JSON.stringify(t.outboxRows()).includes('Viewer Real Name'), 'no event anywhere carries the name');

        for (const as of [{ user: alex }, { cap: ['tips.interaction.get'] }]) {
            const v = (await t.call('GET', `/api/v1/interactions/${anonId}`, as)).json.interaction;
            assert.strictEqual(v.supporter, null);
            assert.strictEqual(v.supporter_name, 'Anonymous');
            assert.ok(!JSON.stringify(v).includes(viewer.subject) && !JSON.stringify(v).includes('Viewer Real Name'));
        }
        const goalView = (await t.call('GET', `/api/v1/goals/${goal.id}`, { user: alex })).json.goal;
        assert.strictEqual(goalView.contributions.find((c) => c.interaction_id === anonId).supporter_name, 'Anonymous');
        const dash = await fetch(`${t.base}/dashboard`, { headers: { Cookie: `ov_token=${t.network.signUser(alex)}` } }).then((x) => x.text());
        assert.ok(!dash.includes('Viewer Real Name'), 'the creator dashboard does not name them');
    });

    let hiddenId;
    await check('a hidden amount: not on overlays or in chat lines; the creator and internal events keep it', async () => {
        const r = await tip(viewer, { amount: 222, message: 'keep it quiet', supporter_name: 'Viewer', privacy: { hide_amount: true } });
        hiddenId = r.json.interaction.id;
        const a = await alertOf(hiddenId);
        assert.strictEqual(a.amount, null);
        assert.strictEqual(a.amount_hidden, true);
        assert.strictEqual(a.supporter_name, 'Viewer');
        assert.strictEqual(JSON.parse(t.db.prepare("SELECT payload FROM overlay_deliveries WHERE kind = 'goal' AND interaction_id = ?").get(hiddenId).payload).by, null,
            'the goal update does not pin the jump on them');
        await domain.effects.drain();
        const [job] = jobsOf(hiddenId);
        assert.strictEqual(job.text, 'Viewer sent a tip: keep it quiet');
        assert.strictEqual(job.interaction.amount, null);
        assert.strictEqual(job.privacy.hide_amount, true);
        assert.strictEqual((await t.call('GET', `/api/v1/interactions/${hiddenId}`, { user: alex })).json.interaction.amount, 222);
        assert.strictEqual(eventsOf('tips.interaction.ready', hiddenId)[0].payload.amount, 222);
    });

    await check('an overlay\'s minimum still applies to a hidden amount (without revealing it)', async () => {
        const cfg = await t.call('POST', '/api/v1/overlay-configs', { user: alex, body: { kind: 'alerts', min_amount: 100 } });
        const t2 = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts'], config_id: cfg.json.config.id } });
        const s = await t.sse(`/overlay/${t2.json.secret}/events`);
        await s.waitFor((e) => e.event === 'hello');
        const small = await tip(viewer, { amount: 10, privacy: { hide_amount: true } });
        const big = await tip(viewer, { amount: 150, privacy: { hide_amount: true } });
        const shown = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === big.json.interaction.id);
        assert.strictEqual(shown.data.amount, null);
        assert.ok(!s.events.some((e) => e.event === 'alert' && e.data.interaction_id === small.json.interaction.id), 'below the minimum');
        s.close();
    });

    let privateId;
    await check('a private message reaches the creator only; paid messages cannot be private', async () => {
        const r = await tip(viewer, { amount: 50, message: 'just for you', supporter_name: 'Viewer', privacy: { private_message: true } });
        privateId = r.json.interaction.id;
        assert.strictEqual((await alertOf(privateId)).message, null);
        await domain.effects.drain();
        assert.strictEqual(jobsOf(privateId)[0].text, 'Viewer tipped 50 Vibes');
        assert.strictEqual(jobsOf(privateId)[0].interaction.message, null);
        assert.strictEqual((await t.call('GET', `/api/v1/interactions/${privateId}`, { user: alex })).json.interaction.message, 'just for you');
        const pm = await t.call('POST', '/api/v1/paid-messages', { user: viewer, body: { creator: 'alex', amount: 200, message: 'x', privacy: { private_message: true } } });
        assert.strictEqual(pm.status, 422);
        const bad = await tip(viewer, { amount: 5, privacy: { secret: true } });
        assert.strictEqual(bad.status, 422);
    });

    await check('the creator chooses what the goal pages show; each supporter\'s choice still applies', async () => {
        await tip(other, { amount: 300, supporter_name: 'Other', goal_id: goal.id });
        let pub = (await t.call('GET', `/api/v1/goals/${goal.id}`, { token: null })).json.goal;
        assert.ok(pub.current_amount > 0 && pub.supporters === undefined && pub.contributions === undefined);
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { page: { goal_amounts: false, goal_supporters: true } } });
        pub = (await t.call('GET', `/api/v1/goals/${goal.id}`, { token: null })).json.goal;
        assert.strictEqual(pub.current_amount, null);
        assert.strictEqual(pub.target_amount, null);
        assert.strictEqual(typeof pub.percent, 'number');
        const names = pub.supporters.map((x) => x.name);
        assert.ok(names.includes('Other') && names.includes('Anonymous'));
        assert.ok(pub.supporters.every((x) => x.amount === null), 'no amounts while goal amounts are off');
        assert.ok(!JSON.stringify(pub).includes('Viewer Real Name'));
        const list = (await t.call('GET', '/api/v1/goals?creator=alex', { token: null })).json.goals;
        assert.strictEqual(list[0].current_amount, null);
        assert.ok((await t.call('GET', `/api/v1/goals/${goal.id}`, { user: alex })).json.goal.current_amount > 0, 'the creator sees everything');
        const html = await fetch(`${t.base}/alex/goals`).then((x) => x.text());
        assert.ok(!/of 100,000 Vibes/.test(html), 'the page shows the percentage only');
        assert.match(html, /Other/);
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { page: { goal_amounts: true } } });
        pub = (await t.call('GET', `/api/v1/goals/${goal.id}`, { token: null })).json.goal;
        const hiddenRow = pub.supporters.find((x) => x.name === 'Viewer' && x.amount === null);
        assert.ok(hiddenRow, 'a hidden amount stays hidden when goal amounts are on');
        assert.strictEqual(pub.supporters.find((x) => x.name === 'Other').amount, 300);
        const bad = await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { page: { everything: true } } });
        assert.strictEqual(bad.status, 422);
    });

    await check('the supporters page: off by default; the creator picks names, amounts and messages', async () => {
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex/supporters', { token: null })).status, 404);
        assert.strictEqual((await fetch(`${t.base}/alex/supporters`)).status, 404);
        await tip(other, { amount: 1000, supporter_name: 'Other', message: 'big fan' });
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { page: { supporters_page: true } } });
        let r = (await t.call('GET', '/api/v1/profiles/alex/supporters', { token: null })).json;
        assert.deepStrictEqual(r.leaderboard.map((x) => x.name), ['Other', 'Viewer']);
        assert.ok(r.leaderboard.every((x) => x.total === null), 'no amounts unless the creator shows them');
        assert.strictEqual(r.recent, null);
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { page: { supporters_amounts: true, supporters_messages: true } } });
        r = (await t.call('GET', '/api/v1/profiles/alex/supporters', { token: null })).json;
        assert.strictEqual(r.leaderboard[0].total, 1300);
        // Viewer's total counts only what they left public: not the anonymous 120, not the hidden 222/10/150.
        assert.strictEqual(r.leaderboard[1].total, 50);
        const msgs = r.recent.map((v) => v.message);
        assert.ok(msgs.includes('big fan') && msgs.includes('from nobody'));
        assert.ok(!msgs.includes('just for you'), 'a private message never shows');
        assert.strictEqual(r.recent.find((v) => v.message === 'from nobody').supporter_name, 'Anonymous');
        assert.strictEqual(r.recent.find((v) => v.message === 'keep it quiet').amount, null);
        const html = await fetch(`${t.base}/alex/supporters`).then((x) => x.text());
        assert.match(html, /big fan/);
        assert.match(html, /<meta name="robots" content="index,follow">/);
        assert.ok(!html.includes('just for you') && !html.includes('Viewer Real Name'));
        assert.match(await fetch(`${t.base}/alex`).then((x) => x.text()), /href="\/alex\/supporters"/);
    });

    await check('the no-JS tip form carries the privacy choices', async () => {
        const cookie = `ov_token=${t.network.signUser(other)}`;
        const page = await fetch(`${t.base}/alex`, { headers: { Cookie: cookie } }).then((x) => x.text());
        assert.match(page, /name="anonymous"/);
        const csrf = page.match(/name="csrf" value="([^"]*)"/)[1];
        const res = await fetch(`${t.base}/alex/tip`, {
            method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
            body: new URLSearchParams({ csrf, idem: 'form-privacy-00001', kind: 'tip', amount: '15', message: 'shh', pay_with: 'credit', supporter_name: 'Other', anonymous: '1', private_message: '1' }).toString(),
        });
        assert.strictEqual(res.status, 303);
        const i = domain.interactions.get(res.headers.get('location').split('/').pop());
        assert.strictEqual(i.anonymous, 1);
        assert.strictEqual(i.private_message, 1);
        assert.strictEqual(i.hide_amount, 0);
    });

    await check('export: a supporter downloads their own tips, with messages and choices, nobody else\'s', async () => {
        const r = await t.call('GET', '/api/v1/me/export', { user: viewer });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.subject.id, viewer.subject);
        assert.ok(r.json.interactions.length >= 5);
        assert.ok(r.json.interactions.every((i) => i.supporter.id === viewer.subject));
        const anon = r.json.interactions.find((i) => i.id === anonId);
        assert.strictEqual(anon.message, 'from nobody');
        assert.strictEqual(anon.privacy.anonymous, true);
        assert.ok(anon.goal_contributions.length === 1);
        assert.strictEqual((await t.call('GET', '/api/v1/me/export', { cap: ['tips.*'] })).status, 403, 'people only');
        const web = await fetch(`${t.base}/receipts/export`, { headers: { Cookie: `ov_token=${t.network.signUser(viewer)}` } });
        assert.match(web.headers.get('content-disposition'), /^attachment; filename="openvibe-tips-/);
        assert.strictEqual(web.headers.get('cache-control'), 'no-store');
        assert.strictEqual((await web.json()).interactions.length, r.json.interactions.length);
    });

    await check('erasure: the person goes, the money record stays; tips.interaction.erased redacts the earlier events', async () => {
        const totalsBefore = domain.interactions.totals(alex.subject);
        const goalBefore = domain.goals.present(domain.goals.get(goal.id)).current_amount;
        const buyer = t.network.newUser('buyer');
        billing.fund(buyer.subject, 1000);
        const kept = await tip(buyer, { amount: 150, pay_with: 'checkout', provider: 'stripe', message: 'pending one' });
        const done1 = await tip(buyer, { amount: 40, message: 'my secret words', supporter_name: 'Buyer Person' });
        assert.ok(t.db.prepare('SELECT COUNT(*) AS n FROM api_idempotency WHERE key LIKE ?').get(`${buyer.subject}:%`).n >= 2);
        const unsent = eventsOf('tips.interaction.ready', done1.json.interaction.id)[0];
        assert.strictEqual(unsent.payload.supporter.id, buyer.subject);

        const r = await t.call('POST', '/api/v1/me/erase', { user: buyer });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.erased, 1);
        assert.strictEqual(r.json.kept_pending, 1);
        assert.ok(r.json.stored_answers_removed >= 2);

        const i = domain.interactions.get(done1.json.interaction.id);
        assert.strictEqual(i.supporter_subject, null);
        assert.strictEqual(i.supporter_name, null);
        assert.strictEqual(i.message, null);
        assert.ok(i.erased_at);
        assert.strictEqual(i.amount, 40);
        assert.ok(i.billing_txn_id, 'the Billing reference stays');
        assert.strictEqual(domain.interactions.get(kept.json.interaction.id).supporter_subject, buyer.subject, 'a pending payment keeps its supporter');
        const a = await alertOf(i.id);
        assert.strictEqual(a.supporter_name, 'Anonymous');
        assert.strictEqual(a.message, null);
        const row = t.db.prepare('SELECT * FROM tip_interactions WHERE id = ?').get(i.id);
        assert.ok(!JSON.stringify(row).includes('my secret words') && !JSON.stringify(row).includes('Buyer Person') && !JSON.stringify(row).includes(buyer.subject));
        const everything = JSON.stringify(t.db.prepare('SELECT * FROM paid_messages').all()) + JSON.stringify(t.db.prepare('SELECT payload FROM overlay_deliveries').all())
            + JSON.stringify(t.db.prepare('SELECT * FROM api_idempotency').all());
        assert.ok(!everything.includes('my secret words') && !everything.includes('Buyer Person'));
        const scrubbed = eventsOf('tips.interaction.ready', i.id)[0];
        assert.strictEqual(scrubbed.payload.supporter, null, 'the local outbox copy no longer names them');
        assert.strictEqual(scrubbed.payload.supporter_name, 'Anonymous');

        const [erased] = eventsOf('tips.interaction.erased', i.id);
        assert.deepStrictEqual(erased.payload.redacts, { subject_type: 'interaction', subject_ids: [i.id] });
        const v = payloadValidator('tips.interaction.erased')(erased.payload);
        assert.ok(v.valid, JSON.stringify(v.errors));
        assert.ok(contracts.validate('events.event-envelope@1', erased).valid);

        const totalsAfter = domain.interactions.totals(alex.subject);
        assert.strictEqual(totalsAfter.settled_via_billing, totalsBefore.settled_via_billing + 40, 'the erased tip still counts');
        assert.strictEqual(totalsAfter.settled_via_billing, billing.payable.get(alex.subject), 'still reconciles to Billing');
        assert.strictEqual(domain.goals.present(domain.goals.get(goal.id)).current_amount, goalBefore + 40, 'the goal keeps the money');
        const receipts = (await t.call('GET', '/api/v1/interactions', { user: buyer })).json.interactions;
        assert.deepStrictEqual(receipts.map((x) => x.id), [kept.json.interaction.id]);
    });

    await check('erasure from the receipts page needs the confirmation and the anti-forgery token', async () => {
        const cookie = `ov_token=${t.network.signUser(other)}`;
        const page = await fetch(`${t.base}/receipts/erase`, { headers: { Cookie: cookie } }).then((x) => x.text());
        assert.match(page, /cannot be undone/);
        const csrf = page.match(/name="csrf" value="([^"]*)"/)[1];
        const post = (form) => fetch(`${t.base}/receipts/erase`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }, body: new URLSearchParams(form).toString() });
        assert.strictEqual((await post({ csrf, idem: 'form-erase-000001' })).status, 403, 'no confirmation');
        assert.strictEqual((await post({ csrf: 'forged', idem: 'form-erase-000002', confirm: '1' })).status, 403);
        assert.ok(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions WHERE supporter_subject = ?').get(other.subject).n > 0);
        const ok = await post({ csrf, idem: 'form-erase-000003', confirm: '1' });
        assert.strictEqual(ok.status, 303);
        assert.match(ok.headers.get('location'), /^\/receipts\?done=/);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM tip_interactions WHERE supporter_subject = ?').get(other.subject).n, 0);
        const lb = (await t.call('GET', '/api/v1/profiles/alex/supporters', { token: null })).json.leaderboard;
        assert.ok(!lb.some((x) => x.name === 'Other'), 'an erased supporter leaves the leaderboard');
    });

    await check('every event is a valid envelope with a valid payload', async () => {
        for (const e of t.outboxRows()) {
            assert.ok(contracts.validate('events.event-envelope@1', e).valid, e.event_type);
            const v = payloadValidator(e.event_type)(e.payload);
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)}`);
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
