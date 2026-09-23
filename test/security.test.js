'use strict';
// Regressions for docs/threat-review.md: amount spoofing through a donation that merely names an
// interaction, overlay stream floods, unpaid-checkout floods, impersonating the creator, invisible and
// markup characters in paid messages, and overlay secrets kept in stored API answers.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { TIPS_MAX_PENDING_CHECKOUTS: '3', TIPS_OVERLAY_MAX_STREAMS: '3' } });
    const { domain, billing } = t;
    const alex = await t.creator('alex', { settings: { tts_enabled: true } });
    const viewer = t.network.newUser('viewer');
    const other = t.network.newUser('other');
    billing.fund(viewer.subject, 10_000);
    billing.fund(other.subject, 10_000);

    await check('amount spoofing: a donation that names an interaction but does not match it never settles it', async () => {
        const r = await t.call('POST', '/api/v1/paid-messages', { user: viewer, body: { creator: 'alex', amount: 5000, message: 'big one', pay_with: 'checkout', provider: 'stripe' } });
        const id = r.json.interaction.id;
        assert.strictEqual(r.json.interaction.payment.state, 'pending');
        const target = { service: 'tips', type: 'interaction', id };
        // 1 bit from the right supporter; the right amount from someone else; the right amount to someone else.
        const cases = [
            billing.foreignDonation({ from: viewer.subject, to: alex.subject, amount: 1, target }),
            billing.foreignDonation({ from: other.subject, to: alex.subject, amount: 5000, target }),
            billing.foreignDonation({ from: viewer.subject, to: other.subject, amount: 5000, target }),
        ];
        for (const ev of cases) {
            const d = await t.deliver(ev);
            assert.strictEqual(d.status, 200);
            assert.strictEqual(d.json.outcome, 'recorded', 'recorded on its own');
        }
        const i = domain.interactions.get(id);
        assert.strictEqual(i.payment_state, 'pending', 'the paid message is still unpaid');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM paid_messages WHERE interaction_id = ?').get(id).n, 0);
        const spoof = domain.interactions.byBillingTxn(cases[0].payload.transaction_id);
        assert.strictEqual(spoof.amount, 1);
        assert.strictEqual(spoof.origin, 'billing');
        assert.strictEqual(domain.interactions.totals(alex.subject).settled_via_billing, billing.payable.get(alex.subject), 'still reconciles to Billing');
    });

    await check('overlay stream floods: a token opens a bounded number of streams at once', async () => {
        const tok = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: {} });
        const open = [];
        for (let k = 0; k < 3; k++) { const s = await t.sse(`/overlay/${tok.json.secret}/events`); assert.strictEqual(s.statusCode, 200); open.push(s); }
        const extra = await fetch(`${t.base}/overlay/${tok.json.secret}/events`);
        assert.strictEqual(extra.status, 429);
        assert.strictEqual(extra.headers.get('referrer-policy'), 'no-referrer');
        open.pop().close();
        await new Promise((ok) => setTimeout(ok, 50));
        const again = await t.sse(`/overlay/${tok.json.secret}/events`);
        assert.strictEqual(again.statusCode, 200, 'a closed stream frees its place');
        again.close();
        open.forEach((s) => s.close());
    });

    await check('unpaid-checkout floods: a supporter holds a bounded number of unpaid checkouts', async () => {
        const buyer = t.network.newUser('buyer');
        for (let k = 0; k < 3; k++) {
            const r = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 100 + k, pay_with: 'checkout', provider: 'stripe' } });
            assert.strictEqual(r.status, 201, r.text);
        }
        const over = await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 200, pay_with: 'checkout', provider: 'stripe' } });
        assert.strictEqual(over.status, 429);
        assert.strictEqual(over.json.code, 'tips.too_many_pending');
        billing.fund(buyer.subject, 100);
        assert.strictEqual((await t.call('POST', '/api/v1/checkout', { user: buyer, body: { creator: 'alex', amount: 50 } })).status, 201, 'paying from credit is not limited');
    });

    await check('impersonation: nobody tips under the creator\'s own name or handle', async () => {
        for (const name of ['Alex', 'alex', '@alex', 'ＡＬＥＸ', 'al​ex']) {
            const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 5, supporter_name: name } });
            assert.strictEqual(r.status, 422, `${JSON.stringify(name)} → ${r.status}`);
            assert.strictEqual(r.json.code, 'tips.name_taken');
        }
        const anon = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 5, supporter_name: 'Alex', privacy: { anonymous: true } } });
        assert.strictEqual(anon.status, 201, 'the name is never shown when anonymous');
    });

    await check('invisible and direction-override characters are dropped; TTS text carries no markup', async () => {
        const r = await t.call('POST', '/api/v1/tts-requests', { user: viewer, body: {
            creator: 'alex', amount: 150, supporter_name: 'Vie‮wer', message: 'hi​ there',
            tts: { text: '<speak><break time="9s"/>hello⁦ world</speak>' },
        } });
        assert.strictEqual(r.status, 201, r.text);
        const i = domain.interactions.get(r.json.interaction.id);
        assert.strictEqual(i.supporter_name, 'Viewer');
        assert.strictEqual(i.message, 'hi there');
        await domain.effects.drain();
        const job = t.adapters.test.jobs.find((j) => j.interaction.id === i.id && j.effect === 'tts');
        assert.ok(!/[<>]/.test(job.tts.text), job.tts.text);
        assert.ok(!/[⁦‮​]/.test(JSON.stringify(job)));
    });

    await check('an overlay secret is shown once: an Idempotency-Key replay does not return it, the database never holds it', async () => {
        const first = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { label: 'replay' }, key: 'overlay-key-0001' });
        assert.match(first.json.secret, /^tovl_/);
        const replay = await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { label: 'replay' }, key: 'overlay-key-0001' });
        assert.strictEqual(replay.headers.get('idempotent-replayed'), 'true');
        assert.strictEqual(replay.json.token.id, first.json.token.id);
        assert.strictEqual(replay.json.secret, null);
        const everything = JSON.stringify(t.db.prepare('SELECT * FROM api_idempotency').all()) + JSON.stringify(t.db.prepare('SELECT * FROM overlay_tokens').all());
        assert.ok(!everything.includes(first.json.secret));
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
