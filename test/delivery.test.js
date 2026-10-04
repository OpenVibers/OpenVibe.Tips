'use strict';
// The chat delivery adapter: OpenVibe.Chat's typed ingress with Tips' service token, the creator's room
// from the Network's identity map, one key per effect (the delivery id) so a retry never posts twice,
// retries for outages, an immediate stop for refusals — and never a change to the payment.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ chat: true });
    const { domain, billing, chat } = t;
    const alex = await t.creator('alex', { liveId: 501, settings: { tts_enabled: true, media_requests_enabled: true } });
    const viewer = t.network.newUser('viewer');
    billing.fund(viewer.subject, 20_000);
    const effectOf = (id, effect) => t.db.maybe('SELECT * FROM interaction_effects WHERE interaction_id = $1 AND effect = $2', [id, effect]);
    const messagesFor = (id) => chat.messages.filter((m) => m.body.metadata.interaction_id === id);

    await check('a settled tip: a donation line (R1) and the alert (R2) in the creator\'s Live channel, keyed by the delivery id', async () => {
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 1200, message: 'gg' } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        const [m] = messagesFor(id);
        assert.ok(m, 'posted to Chat');
        assert.deepStrictEqual(m.body, {
            key: `${id}:chat_line`, channel_user_id: 501, username: 'Viewer', message: 'Viewer tipped 1,200 Vibes: gg', message_type: 'donation',
            source_platform: 'tips', mirror: true,
            metadata: { kind: 'donation', source: 'tips', amount: 1200, message: 'gg', username: 'Viewer', interaction_id: id, paid_message: false, highlight_seconds: 0, test: false },
        });
        const alert = chat.events.find((e) => e.key === `${id}:chat_line:alert`);
        assert.deepStrictEqual(alert.body, { key: `${id}:chat_line:alert`, target: { kind: 'channel', id: 501 }, frame: { type: 'alert', streamerId: 501, kind: 'donation' } });
        assert.deepStrictEqual((await effectOf(id, 'chat_line')).result.ref, { chat_message_id: chat.messages.indexOf(m) + 1, alert: true });
        assert.strictEqual(t.network.grants.find((g) => g.audience === 'openvibe.chat').scope, 'chat.message.send chat.event.publish');
        assert.strictEqual(t.network.grants.find((g) => g.audience === 'openvibe.network').scope, 'identity.subject.resolve');
        assert.strictEqual(t.network.resolves.filter((u) => u.includes(encodeURIComponent(alex.subject))).length, 1);
    });

    await check('a paid message is a donation line flagged paid_message with its highlight', async () => {
        const r = await t.call('POST', '/api/v1/paid-messages', { user: viewer, body: { creator: 'alex', amount: 500, message: 'hello chat' } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json.interaction.id;
        await domain.effects.drain();
        const [m] = messagesFor(id);
        const pm = await t.db.maybe('SELECT * FROM paid_messages WHERE interaction_id = $1', [id]);
        assert.deepStrictEqual([m.key, m.body.message_type, m.body.mirror, m.body.metadata.paid_message, m.body.metadata.highlight_seconds, m.body.metadata.message],
            [`${id}:paid_message`, 'donation', true, true, pm.highlight_seconds, 'hello chat']);
        assert.strictEqual(pm.status, 'delivered');
        assert.ok(chat.events.some((e) => e.key === `${id}:paid_message:alert`));
        assert.strictEqual(t.network.resolves.length, 1, 'the room is remembered');
    });

    await check('TTS: the donation line, then a tts line Chat reads aloud with the filtered text and the voice', async () => {
        const r = await t.call('POST', '/api/v1/tts-requests', { user: viewer, body: { creator: 'alex', amount: 150, tts: { text: 'hello https://x.example there' } } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json.interaction.id;
        await domain.effects.drain();
        const tts = messagesFor(id).find((m) => m.key === `${id}:tts`);
        assert.deepStrictEqual(tts.body, {
            key: `${id}:tts`, channel_user_id: 501, username: 'Viewer', message: 'hello link there', message_type: 'tts', source_platform: 'tips',
            tts: { voice: 'gary', identity_key: `tips:${id}`, key: `tips-${id}` }, metadata: { kind: 'tts', source: 'tips', interaction_id: id, test: false },
        });
        assert.ok(messagesFor(id).some((m) => m.key === `${id}:chat_line`));
        assert.ok(!chat.events.some((e) => e.key === `${id}:tts:alert`), 'one alert per tip, on its line');
    });

    await check('Chat down (503): retried later with the same key, posted once; the payment stays settled throughout', async () => {
        chat.state.fail = 503;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 7 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        let e = await effectOf(id, 'chat_line');
        assert.strictEqual(e.state, 'queued');
        assert.match(e.last_error, /Chat 503/);
        assert.strictEqual((await domain.interactions.get(t.db, id)).payment_state, 'settled');
        chat.state.fail = null;
        t.clock.offset += 5000;
        await domain.effects.drain();
        t.clock.offset = 0;
        e = await effectOf(id, 'chat_line');
        assert.strictEqual(e.state, 'delivered');
        assert.strictEqual(e.attempts, 2);
        assert.deepStrictEqual(chat.calls.filter((c) => c.route === '/internal/chat/messages' && c.key === `${id}:chat_line`).length, 2);
        assert.strictEqual(messagesFor(id).length, 1);
        assert.strictEqual((await domain.interactions.get(t.db, id)).delivery_state, 'delivered');
    });

    await check('the line posted but the alert hit a 503: the retry replays the line under its key (no second line) and sends the alert', async () => {
        chat.state.failEvents = 503;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 9 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        assert.strictEqual((await effectOf(id, 'chat_line')).state, 'queued');
        assert.strictEqual(messagesFor(id).length, 1);
        chat.state.failEvents = null;
        t.clock.offset += 5000;
        await domain.effects.drain();
        t.clock.offset = 0;
        assert.strictEqual(messagesFor(id).length, 1, 'Chat answered the repeat with the first result');
        assert.strictEqual(chat.events.filter((ev) => ev.key === `${id}:chat_line:alert`).length, 1);
        assert.deepStrictEqual((await effectOf(id, 'chat_line')).result.ref.alert, true);
    });

    await check('a refused alert (4xx) does not undo the line: delivered, alert false', async () => {
        chat.state.failEvents = 400;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 11 } });
        await domain.effects.drain();
        chat.state.failEvents = null;
        const e = await effectOf(r.json.interaction.id, 'chat_line');
        assert.strictEqual(e.state, 'delivered');
        assert.strictEqual(e.result.ref.alert, false);
    });

    await check('Chat refuses (400): the effect fails at once without a retry, tips.interaction.failed, payment untouched', async () => {
        chat.state.fail = 400;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 8 } });
        const id = r.json.interaction.id;
        await domain.effects.drain();
        chat.state.fail = null;
        const e = await effectOf(id, 'chat_line');
        assert.deepStrictEqual([e.state, e.attempts], ['failed', 1]);
        assert.match(e.last_error, /Chat 400/);
        const i = await domain.interactions.get(t.db, id);
        assert.deepStrictEqual([i.delivery_state, i.payment_state], ['failed', 'settled']);
        assert.ok(billing.payable.get(alex.subject) >= 8);
        assert.strictEqual((await t.outboxRows('tips.interaction.failed')).filter((ev) => ev.subject.id === id).length, 1);
    });

    await check('a creator with no Live account has no Chat room: failed at once, payment untouched, nothing posted', async () => {
        const nolive = await t.creator('nolive');
        const before = chat.calls.length;
        const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'nolive', amount: 10 } });
        await domain.effects.drain();
        const e = await effectOf(r.json.interaction.id, 'chat_line');
        assert.deepStrictEqual([e.state, e.attempts], ['failed', 1]);
        assert.match(e.last_error, /no Live channel/);
        assert.strictEqual((await domain.interactions.get(t.db, r.json.interaction.id)).payment_state, 'settled');
        assert.strictEqual(chat.calls.length, before);
        assert.ok(nolive.subject);
    });

    await check('a media request has no Chat route: failed at once, the request recorded failed, payment untouched', async () => {
        const r = await t.call('POST', '/api/v1/media-requests', { user: viewer, body: { creator: 'alex', amount: 150, media: { url: 'https://www.youtube.com/watch?v=abc' } } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json.interaction.id;
        await domain.effects.drain();
        const e = await effectOf(id, 'media_request');
        assert.strictEqual(e.state, 'failed');
        assert.match(e.last_error, /no media_request route/);
        assert.strictEqual(await t.db.value('SELECT status FROM paid_media_requests WHERE interaction_id = $1', [id]), 'failed');
        assert.strictEqual((await domain.interactions.get(t.db, id)).payment_state, 'settled');
        assert.strictEqual(messagesFor(id).length, 0);
    });

    await check('simulations never reach Chat: their chat effects stay in the test adapter', async () => {
        const profile = await t.domain.profiles.byHandle(t.db, 'alex');
        const before = chat.calls.length;
        const sim = await domain.interactions.simulate(profile, { kind: 'tip', amount: 100 }, { by: profile.creator_subject });
        await domain.effects.drain();
        assert.strictEqual(chat.calls.length, before);
        assert.ok(t.adapters.test.jobs.some((j) => j.interaction.id === sim.id && j.test));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
