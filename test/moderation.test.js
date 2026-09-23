'use strict';
// Moderation: the creator's word filter (mask or hold) before anything is shown or read; the creator,
// their moderators (invitation links) and granted services hide or show paid messages on overlays,
// chat still to come and public pages; the money is never touched; outcomes are logged and published
// as tips.interaction.moderated.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const registry = require('openvibe-contracts/lib/registry');
const { boot, check, done } = require('./helpers/app');

function payloadValidator(type) {
    try { contracts.resolve(type); return (p) => contracts.validate(type, p); } catch { /* not released yet */ }
    const fn = registry.ajv.compile(require(`../docs/events-proposal/${type}.v1.json`));
    return (p) => ({ valid: fn(p), errors: fn.errors || [] });
}
const validModerated = payloadValidator('tips.interaction.moderated');

(async () => {
    const t = await boot();
    const { domain, billing } = t;
    const alex = await t.creator('alex', { settings: { tts_enabled: true, page: { supporters_page: true, supporters_messages: true } } });
    const viewer = t.network.newUser('viewer');
    const mod = t.network.newUser('modder');
    const stranger = t.network.newUser('stranger');
    billing.fund(viewer.subject, 100_000);
    const goal = (await t.call('POST', '/api/v1/goals', { user: alex, body: { title: 'Desk', target_amount: 100_000 } })).json.goal;
    const tok = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts', 'goals'] } });
    const secret = tok.json.secret;
    const pay = (kind, body) => t.call('POST', { tip: '/api/v1/checkout', paid_message: '/api/v1/paid-messages', tts: '/api/v1/tts-requests' }[kind], { user: viewer, body: { creator: 'alex', ...body } });
    const state = async () => (await t.call('GET', `/overlay/${secret}/state`, { token: null })).json.alerts;
    const jobsOf = (id) => t.adapters.test.jobs.filter((j) => j.interaction.id === id);
    const moderated = (id) => t.outboxRows('tips.interaction.moderated').filter((e) => e.subject.id === id).map((e) => e.payload);
    const cookie = (u) => `ov_token=${t.network.signUser(u)}`;
    const get = (p, u) => fetch(t.base + p, { headers: u ? { Cookie: cookie(u) } : {}, redirect: 'manual' }).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
    const post = (p, u, form) => fetch(t.base + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie(u) }, body: new URLSearchParams(form).toString() })
        .then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));
    const field = (html, name) => { const m = html.match(new RegExp(`name="${name}" value="([^"]*)"`)); return m ? m[1] : null; };

    await check('the filter settings are the creator\'s, validated, and never public', async () => {
        const bad = await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { filter: { action: 'nuke' } } });
        assert.strictEqual(bad.status, 422);
        const long = await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { filter: { words: ['x'.repeat(61)] } } });
        assert.strictEqual(long.status, 422);
        const ok = await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { filter: { words: 'Badword\ntwo words, badword', action: 'mask' } } });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.deepStrictEqual(ok.json.profile.filter, { words: ['badword', 'two words'], action: 'mask', links: true });
        const pub = await t.call('GET', '/api/v1/profiles/alex', { token: null });
        assert.strictEqual(pub.json.profile.filter, undefined, 'the blocklist is private');
    });

    await check('mask: blocked words are starred out of overlays, chat and pages, dropped from TTS; tricks do not get through', async () => {
        const r = await pay('paid_message', { amount: 200, supporter_name: 'badword fan', message: 'you BADWORD, two  words and ｂａｄｗｏｒｄ and bad​word https://phish.example/x ok' });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json.interaction.id;
        const a = (await state()).find((x) => x.interaction_id === id);
        assert.strictEqual(a.supporter_name, '******* fan');
        assert.strictEqual(a.message, 'you *******, ********** and ******* and ******* [link] ok');
        await domain.effects.drain();
        assert.match(jobsOf(id)[0].text, /^\*\*\*\*\*\*\* fan tipped 200 Vibes: you \*\*\*\*\*\*\*,/);
        assert.ok(!jobsOf(id)[0].text.includes('phish'));
        const own = (await t.call('GET', `/api/v1/interactions/${id}`, { user: alex })).json.interaction;
        assert.match(own.message, /BADWORD/, 'the creator reads the original');
        assert.strictEqual(own.moderation.filtered, true);
        assert.strictEqual(own.moderation.state, 'visible');
        const [ev] = moderated(id);
        assert.deepStrictEqual(ev, { interaction_id: id, creator: { type: 'user', id: alex.subject }, action: 'filtered', by: 'filter', moderation_state: 'visible', cancelled_effects: [] });
        const tts = await pay('tts', { amount: 150, tts: { text: 'say badword now please' } });
        await domain.effects.drain();
        assert.strictEqual(jobsOf(tts.json.interaction.id).find((j) => j.effect === 'tts').tts.text, 'say now please');
        const page = await get('/alex/supporters');
        assert.ok(!/badword/i.test(page.text.replace(/<style[\s\S]*?<\/style>/g, '')), 'the supporters page shows no blocked word');
    });

    let heldId;
    await check('hold: nothing is shown, posted or read until someone reviews it; the money counts at once', async () => {
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { filter: { action: 'hold' } } });
        const goalBefore = domain.goals.present(domain.goals.get(goal.id)).current_amount;
        const s = await t.sse(`/overlay/${secret}/events`);
        await s.waitFor((e) => e.event === 'hello');
        const r = await pay('tts', { amount: 300, supporter_name: 'Viewer', tts: { text: 'read this badword aloud' } });
        heldId = r.json.interaction.id;
        await domain.effects.drain();
        await new Promise((ok) => setTimeout(ok, 50));
        assert.ok(!s.events.some((e) => e.event === 'alert' && e.data.interaction_id === heldId), 'no overlay alert');
        s.close();
        assert.ok(!(await state()).some((x) => x.interaction_id === heldId));
        assert.strictEqual(jobsOf(heldId).length, 0, 'no chat line, no TTS');
        const i = domain.interactions.get(heldId);
        assert.strictEqual(i.payment_state, 'settled');
        assert.strictEqual(i.moderation, 'held');
        assert.strictEqual(i.delivery_state, 'queued', 'waiting for review, not "delivered"');
        assert.strictEqual(domain.goals.present(domain.goals.get(goal.id)).current_amount, goalBefore + 300);
        assert.strictEqual(t.outboxRows('tips.interaction.ready').filter((e) => e.subject.id === heldId).length, 1);
        assert.deepStrictEqual(moderated(heldId).map((e) => [e.action, e.by, e.moderation_state]), [['held', 'filter', 'held']]);
        const q = await t.call('GET', '/api/v1/moderation?creator=alex&state=held', { user: alex });
        assert.deepStrictEqual(q.json.interactions.map((x) => x.id), [heldId]);
        assert.strictEqual(q.json.interactions[0].tts_text, 'read this badword aloud', 'reviewers read what was written');
        assert.strictEqual(q.json.interactions[0].public.hidden, true);
    });

    await check('moderators: a show-once invitation link, accepted signed in; only the creator manages them', async () => {
        const dash = await get('/dashboard', alex);
        assert.match(dash.text, /Word filter/);
        const csrf = field(dash.text, 'csrf');
        const inv = await post('/dashboard/moderator-invites', alex, { csrf, idem: 'x' });
        assert.strictEqual(inv.status, 201);
        assert.strictEqual(inv.headers.get('cache-control'), 'no-store');
        const url = inv.text.match(/value="(http:\/\/tips\.test\/moderate\/invite\/tmin_[^"]+)"/)[1];
        const path = url.replace('http://tips.test', '');
        assert.ok(!(await get('/dashboard', alex)).text.includes(url), 'shown once');
        assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM tip_moderator_invites').all()).includes(path.split('/').pop()), 'stored hashed');
        assert.match((await get(path)).headers.get('location'), /^\/auth\/login/);
        const page = await get(path, mod);
        assert.strictEqual(page.status, 200);
        assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
        assert.match(page.text, /Become a moderator/);
        const forged = await post(path, mod, { csrf: 'nope', idem: 'x' });
        assert.strictEqual(forged.status, 403);
        const ok = await post(path, mod, { csrf: field(page.text, 'csrf'), idem: 'x' });
        assert.strictEqual(ok.status, 303);
        assert.match(ok.headers.get('location'), /^\/moderate\/alex\?done=/);
        assert.strictEqual((await post(path, stranger, { csrf: field((await get('/alex', stranger)).text, 'csrf'), idem: 'x' })).status, 404, 'used once');
        assert.strictEqual((await get('/api/v1/moderators?creator=alex', null)).status, 401);
        const list = await t.call('GET', '/api/v1/moderators', { user: alex });
        assert.deepStrictEqual(list.json.moderators.map((m) => m.moderator.id), [mod.subject]);
        assert.strictEqual((await t.call('GET', '/api/v1/moderators?creator=alex', { user: mod })).status, 403, 'moderators do not manage moderators');
    });

    await check('a moderator shows a held message: it is released as settlement would have released it', async () => {
        const page = await get('/moderate/alex?state=held', mod);
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /read this badword aloud/);
        const s = await t.sse(`/overlay/${secret}/events`);
        await s.waitFor((e) => e.event === 'hello');
        const r = await post(`/moderate/alex/${heldId}/restore`, mod, { csrf: field(page.text, 'csrf'), idem: 'x' });
        assert.strictEqual(r.status, 303);
        const alert = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === heldId);
        s.close();
        assert.strictEqual(alert.data.tts.text, 'read this aloud', 'blocked words stay out of what is read');
        await domain.effects.drain();
        assert.deepStrictEqual(jobsOf(heldId).map((j) => j.effect).sort(), ['chat_line', 'tts']);
        const i = domain.interactions.get(heldId);
        assert.strictEqual(i.moderation, 'visible');
        assert.strictEqual(i.delivery_state, 'delivered');
        assert.deepStrictEqual(moderated(heldId).map((e) => [e.action, e.by, e.moderation_state]), [['held', 'filter', 'held'], ['restored', 'moderator', 'visible']]);
    });

    let hiddenId;
    await check('hide: queued chat/TTS cancelled, overlay alert retracted (live, replay, /state), pages drop it; the money untouched', async () => {
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { filter: { words: [] } } });
        const payableBefore = billing.payable.get(alex.subject);
        const s = await t.sse(`/overlay/${secret}/events`);
        await s.waitFor((e) => e.event === 'hello');
        const r = await pay('tts', { amount: 500, supporter_name: 'Viewer', message: 'nasty but not blocked', tts: { text: 'nasty but not blocked' } });
        hiddenId = r.json.interaction.id;
        const alert = await s.waitFor((e) => e.event === 'alert' && e.data.interaction_id === hiddenId);
        const goalBefore = domain.goals.present(domain.goals.get(goal.id)).current_amount;
        const h = await t.call('POST', `/api/v1/interactions/${hiddenId}/hide`, { user: mod, body: { reason: 'abuse' } });
        assert.strictEqual(h.status, 200, h.text);
        assert.strictEqual(h.json.changed, true);
        assert.deepStrictEqual(h.json.cancelled_effects.sort(), ['chat_line', 'tts']);
        const retract = await s.waitFor((e) => e.event === 'retract' && e.data.interaction_id === hiddenId);
        assert.strictEqual(retract.data.delivery_id, alert.data.delivery_id);
        s.close();
        await domain.effects.drain();
        assert.strictEqual(jobsOf(hiddenId).length, 0, 'nothing was posted or read');
        const i = domain.interactions.get(hiddenId);
        assert.strictEqual(i.payment_state, 'settled');
        assert.strictEqual(i.delivery_state, 'cancelled');
        assert.strictEqual(billing.payable.get(alex.subject), payableBefore + 500, 'the payment stands');
        assert.strictEqual(domain.goals.present(domain.goals.get(goal.id)).current_amount, goalBefore, 'the goal keeps it');
        assert.ok(!(await state()).some((x) => x.interaction_id === hiddenId));
        const replay = await t.sse(`/overlay/${secret}/events`, { lastEventId: alert.id - 1 });
        await replay.waitFor((e) => e.event === 'hello');
        await new Promise((ok) => setTimeout(ok, 50));
        assert.ok(!replay.events.some((e) => e.event === 'alert' && e.data.interaction_id === hiddenId), 'a replay skips it');
        replay.close();
        const sup = (await t.call('GET', '/api/v1/profiles/alex/supporters', { token: null })).json;
        assert.ok(!sup.recent.some((v) => v.interaction_id === hiddenId));
        assert.strictEqual(t.outboxRows('tips.interaction.cancelled').filter((e) => e.subject.id === hiddenId).length, 0, 'not a payment cancellation');
        const [ev] = moderated(hiddenId);
        assert.deepStrictEqual({ ...ev, cancelled_effects: ev.cancelled_effects.sort() }, { interaction_id: hiddenId, creator: { type: 'user', id: alex.subject }, action: 'hidden', by: 'moderator', moderation_state: 'hidden', cancelled_effects: ['chat_line', 'tts'] });
        assert.ok(!JSON.stringify(ev).includes('abuse') && !JSON.stringify(ev).includes(mod.subject), 'the event carries no note and no moderator');
        const again = await t.call('POST', `/api/v1/interactions/${hiddenId}/hide`, { user: alex });
        assert.strictEqual(again.json.changed, false);
        assert.strictEqual(moderated(hiddenId).length, 1, 'hiding twice publishes once');
        const receipt = (await t.call('GET', `/api/v1/interactions/${hiddenId}`, { user: viewer })).json.interaction;
        assert.strictEqual(receipt.moderation.state, 'hidden');
        assert.strictEqual(receipt.payment.state, 'settled');
    });

    await check('restore after a hide: back on pages and overlay state; what was cancelled stays cancelled', async () => {
        const r = await t.call('POST', `/api/v1/interactions/${hiddenId}/restore`, { user: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.ok((await state()).some((x) => x.interaction_id === hiddenId));
        await domain.effects.drain();
        assert.strictEqual(jobsOf(hiddenId).length, 0, 'no late TTS');
        assert.ok((await t.call('GET', '/api/v1/profiles/alex/supporters', { token: null })).json.recent.some((v) => v.interaction_id === hiddenId));
        assert.deepStrictEqual(moderated(hiddenId).map((e) => [e.action, e.by]), [['hidden', 'moderator'], ['restored', 'creator']]);
    });

    await check('who may moderate: the creator, their moderators, services with tips.interaction.moderate; nobody else', async () => {
        const r = await pay('paid_message', { amount: 200, message: 'hello' });
        const id = r.json.interaction.id;
        assert.strictEqual((await t.call('POST', `/api/v1/interactions/${id}/hide`, { user: stranger })).status, 404);
        assert.strictEqual((await t.call('POST', `/api/v1/interactions/${id}/hide`, { user: viewer })).status, 404, 'the supporter cannot hide it either');
        assert.strictEqual((await t.call('POST', `/api/v1/interactions/${id}/hide`, { token: null })).status, 401);
        assert.strictEqual((await t.call('POST', `/api/v1/interactions/${id}/hide`, { cap: ['tips.interaction.get'] })).status, 403);
        const svc = await t.call('POST', `/api/v1/interactions/${id}/hide`, { cap: ['tips.interaction.moderate'], sub: 'svc:chat' });
        assert.strictEqual(svc.status, 200, svc.text);
        assert.strictEqual(moderated(id)[0].by, 'service');
        assert.strictEqual((await get('/moderate/alex', stranger)).status, 404);
        assert.strictEqual((await t.call('GET', '/api/v1/moderation?creator=alex', { user: stranger })).status, 403);
        const log = await t.call('GET', '/api/v1/moderation/log?creator=alex', { user: alex });
        assert.ok(log.json.log.some((l) => l.interaction_id === id && l.by_role === 'service' && l.actor === 'svc:chat'));
        assert.strictEqual((await t.call('GET', '/api/v1/moderation/log?creator=alex', { user: mod })).status, 403);
        // Removed: the moderator loses access at once.
        const dash = await get('/dashboard', alex);
        const rm = await post(`/dashboard/moderators/${mod.subject}/remove`, alex, { csrf: field(dash.text, 'csrf'), idem: 'x' });
        assert.strictEqual(rm.status, 303);
        assert.strictEqual((await get('/moderate/alex', mod)).status, 404);
        assert.strictEqual((await t.call('POST', `/api/v1/interactions/${id}/restore`, { user: mod })).status, 404);
    });

    await check('a tip hidden while its payment is pending delivers nothing once paid', async () => {
        const buyer = t.network.newUser('buyer');
        const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 150, message: 'later', pay_with: 'checkout', provider: 'stripe' } });
        const id = r.json.interaction.id;
        assert.strictEqual((await t.call('POST', `/api/v1/interactions/${id}/hide`, { user: alex })).status, 200);
        await t.deliver(billing.settlePurchase(domain.interactions.get(id).billing_intent_id));
        await new Promise((ok) => setTimeout(ok, 50));
        await domain.interactions.processDueTransfers();
        const i = domain.interactions.get(id);
        assert.strictEqual(i.payment_state, 'settled');
        assert.strictEqual(i.delivery_state, 'cancelled');
        await domain.effects.drain();
        assert.strictEqual(jobsOf(id).length, 0);
        assert.ok(!(await state()).some((x) => x.interaction_id === id));
    });

    await check('simulations run through the filter too, and publish nothing', async () => {
        await t.call('PATCH', '/api/v1/profiles/me', { user: alex, body: { filter: { words: ['badword'], action: 'hold' } } });
        const r = await t.call('POST', '/api/v1/simulate', { user: alex, body: { kind: 'paid_message', amount: 200, message: 'a badword test' } });
        assert.strictEqual(r.json.interaction.moderation.state, 'held');
        assert.strictEqual(moderated(r.json.interaction.id).length, 0);
        const shown = await t.call('POST', `/api/v1/interactions/${r.json.interaction.id}/restore`, { user: alex });
        assert.strictEqual(shown.json.interaction.moderation.state, 'visible');
        assert.strictEqual((await state()).find((x) => x.interaction_id === r.json.interaction.id).message, 'a ******* test');
        // Held, then hidden, then shown: released once, and its delivery state follows.
        const r2 = await t.call('POST', '/api/v1/simulate', { user: alex, body: { kind: 'paid_message', amount: 200, message: 'another badword' } });
        const id2 = r2.json.interaction.id;
        await t.call('POST', `/api/v1/interactions/${id2}/hide`, { user: alex });
        assert.strictEqual(domain.interactions.get(id2).delivery_state, 'cancelled');
        await t.call('POST', `/api/v1/interactions/${id2}/restore`, { user: alex });
        await domain.effects.drain();
        assert.strictEqual(domain.interactions.get(id2).delivery_state, 'delivered');
        assert.strictEqual(jobsOf(id2).length, 1);
        assert.ok((await state()).some((x) => x.interaction_id === id2));
    });

    await check('every event is a valid envelope with a valid payload', async () => {
        for (const e of t.outboxRows()) {
            assert.ok(contracts.validate('events.event-envelope@1', e).valid, e.event_type);
            const v = e.event_type === 'tips.interaction.moderated' ? validModerated(e.payload) : payloadValidator(e.event_type)(e.payload);
            assert.ok(v.valid, `${e.event_type}: ${JSON.stringify(v.errors)} ${JSON.stringify(e.payload)}`);
        }
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
