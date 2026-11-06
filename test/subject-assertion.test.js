'use strict';
/**
 * Subject assertions on the money routes (server/api/subject-assertion.js; ADR-003, the 2026-11-06
 * amendment; plan H1).
 *
 * A service that tips for a person carries the person's own Network-signed assertion
 * (X-OV-Subject-Assertion): the signature, the audience, the service it was minted for and the
 * person it names. A forged, expired, replayed or wrong-audience assertion is refused; one that
 * names another person never tips in their name.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    console.log('subject assertions');
    const t = await boot();
    const alex = await t.creator('alex');
    const viewer = t.network.newUser('viewer');
    const other = t.network.newUser('other');
    t.billing.fund(viewer.subject, 10_000);
    const tip = (o = {}) => t.call('POST', '/api/v1/checkout', {
        cap: ['tips.checkout.create'],
        body: { creator: 'alex', supporter: { type: 'user', id: viewer.subject }, amount: 10 },
        ...o,
    });
    const assertion = (o = {}) => t.network.signAssertion({ subject: viewer.subject, act: 'svc:live', ...o });

    await check('without the flag, a service tips for a person the old way', async () => {
        const r = await tip();
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('without the flag, an assertion that names the person is accepted', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': assertion() } });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('an assertion that names another person is refused', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': assertion({ subject: other.subject }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'subject.assertion_mismatch');
    });

    await check('an assertion minted for another service is refused', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': assertion({ act: 'svc:vip' }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.actor_mismatch');
    });

    await check('a service that is not named in the chain may not carry the assertion', async () => {
        // Live vouches for the person; only the services it names may carry it.
        const chained = assertion({ for: ['svc:live', 'svc:tips'] });
        const r = await tip({ headers: { 'x-ov-subject-assertion': chained } });
        assert.strictEqual(r.status, 201, r.text);
        const stranger = await tip({ headers: { 'x-ov-subject-assertion': assertion({ for: ['svc:live'] }) }, sub: 'svc:vip' });
        assert.strictEqual(stranger.status, 403, stranger.text);
        assert.strictEqual(stranger.json.code, 'assertion.actor_mismatch');
    });

    await check('without the flag, a forged assertion does not stop the tip (the old way continues)', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': 'not.a.jwt' } });
        assert.strictEqual(r.status, 201, r.text);
    });

    // The flag on: the old way is refused.
    const t2 = await boot({ env: { TIPS_REQUIRE_SUBJECT_ASSERTION: 'on' } });
    await t2.creator('alex');
    const fan = t2.network.newUser('fan');
    t2.billing.fund(fan.subject, 10_000);
    const tip2 = (o = {}) => t2.call('POST', '/api/v1/checkout', {
        cap: ['tips.checkout.create'],
        body: { creator: 'alex', supporter: { type: 'user', id: fan.subject }, amount: 10 },
        ...o,
    });
    const assertion2 = (o = {}) => t2.network.signAssertion({ subject: fan.subject, act: 'svc:live', ...o });

    await check('with the flag on, a tip without an assertion is refused', async () => {
        const r = await tip2();
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'subject.assertion_required');
    });

    await check('with the flag on, the person\'s own assertion lets the tip through', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': assertion2() } });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('with the flag on, a forged assertion is refused', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': 'not.a.jwt' } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.malformed');
    });

    await check('with the flag on, an expired assertion is refused', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': assertion2({ expSec: -30 }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.expired');
    });

    await check('with the flag on, an assertion for another audience is refused', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': assertion2({ audience: 'openvibe.billing' }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.wrong_audience');
    });

    await check('with the flag on, a replayed assertion is refused the second time', async () => {
        const a = assertion2();
        const first = await tip2({ headers: { 'x-ov-subject-assertion': a } });
        assert.strictEqual(first.status, 201, first.text);
        const second = await tip2({ headers: { 'x-ov-subject-assertion': a } });
        assert.strictEqual(second.status, 403, second.text);
        assert.strictEqual(second.json.code, 'assertion.replayed');
    });

    await check('a person tipping for themselves needs no assertion', async () => {
        const r = await t2.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 10 } });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('a person tipping for themselves mints an assertion for Billing', async () => {
        // Tips is the one that asks Billing to move the money, so Tips mints the assertion from the
        // person's own token and carries it on.
        const r = await t2.call('POST', '/api/v1/checkout', { user: fan, body: { creator: 'alex', amount: 10 } });
        assert.strictEqual(r.status, 201, r.text);
        const call = t2.billing.transfers().pop();
        assert.ok(call && call.assertion, 'the tip carried an assertion to Billing');
        const claims = JSON.parse(Buffer.from(call.assertion.split('.')[1], 'base64url').toString('utf8'));
        assert.strictEqual(claims.sub, fan.subject);
        assert.deepStrictEqual(claims.aud, ['openvibe.billing']);
        assert.strictEqual(claims.act, 'svc:tips');
        assert.ok(claims.for.includes('svc:tips'), 'Tips may carry it');
    });

    await check('a service that tips for a person carries its own assertion on to Billing', async () => {
        const a = t2.network.signAssertion({ subject: fan.subject, act: 'svc:live', audience: ['openvibe.tips', 'openvibe.billing'], for: ['svc:live', 'svc:tips'] });
        const r = await t2.call('POST', '/api/v1/checkout', {
            cap: ['tips.checkout.create'], body: { creator: 'alex', supporter: { type: 'user', id: fan.subject }, amount: 10 },
            headers: { 'x-ov-subject-assertion': a },
        });
        assert.strictEqual(r.status, 201, r.text);
        const call = t2.billing.transfers().pop();
        assert.strictEqual(call.assertion, a, 'the assertion the service brought is the one Billing gets');
    });

    await check('the counters the flag plan waits for are on /metrics', async () => {
        const m = await fetch(`${t2.base}/metrics`).then((r) => r.text());
        assert.ok(/tips_subject_assertion_calls\{state="asserted"\}/.test(m), 'the calls that carried an assertion are counted');
        assert.ok(/tips_subject_assertion_calls\{state="unasserted"\}/.test(m), 'the calls that came without one are counted');
        assert.ok(!/usr_[0-9A-Z]{26}/.test(m), 'no subject ever appears in metrics');
    });

    await done();
})().catch((err) => { console.error(err); process.exit(1); });
