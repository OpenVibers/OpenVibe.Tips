'use strict';
// Per-actor rate limits on /api/v1 (server/api/actor-limits.js, roadmap WS-R task 4): past its limit one
// caller gets 429 problem+json `rate_limited` with Retry-After, before the route does any work, while
// another caller still passes; the window reopens on the clock. Payments have their own budget: a
// refused one never reaches Billing. Health, ready, release.json, metrics and the Events deliveries are
// never limited; refusals are logged (no token) and counted.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { actor } = require('../server/api/actor-limits');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const t = await boot({ env: { TIPS_LIMITS_MINUTE: '3', TIPS_LIMITS_HOUR: '100' }, appOpts: { limitsNow: () => clock } });
    const { billing } = t;
    await t.creator('alex');
    const viewer = t.network.newUser('viewer');
    const other = t.network.newUser('other');
    billing.fund(viewer.subject, 10_000);
    billing.fund(other.subject, 10_000);

    await check('a read: 3 a minute per person, then 429 rate_limited with Retry-After; another caller passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex', { user: viewer })).status, 200);
        const r = await t.call('GET', '/api/v1/profiles/alex', { user: viewer });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
        assert.deepStrictEqual([r.json.code, r.json.status, r.json.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.json.detail.includes('tips.read'), r.json.detail);
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex', { user: other })).status, 200, 'another person still passes');
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex')).status, 200, 'a service is its own caller');
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex', { token: 'not.a.token' })).status, 401, 'a bad token: 401 from auth, never a 429');
        clock += 45 * 1000;
        assert.strictEqual((await t.call('GET', '/api/v1/profiles/alex', { user: viewer })).status, 200, 'the next minute opens the window again');
    });

    await check('payments: 20 a minute per person, the 21st refused before Billing; a relaying service has its own budget', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        for (let i = 0; i < 20; i++) {
            const r = await t.call('POST', '/api/v1/checkout', { user: viewer, body: { creator: 'alex', amount: 10 } });
            assert.strictEqual(r.status, 201, `tip ${i + 1}: ${r.text}`);
        }
        const transfers = billing.transfers().length;
        const r = await t.call('POST', '/api/v1/paid-messages', { user: viewer, body: { creator: 'alex', amount: 10, message: 'one more' } });
        assert.deepStrictEqual([r.status, r.json.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        assert.strictEqual(billing.transfers().length, transfers, 'Billing never heard of it');
        assert.strictEqual((await t.call('POST', '/api/v1/checkout', { user: other, body: { creator: 'alex', amount: 10 } })).status, 201, 'another person still tips');
        const relayed = await t.call('POST', '/api/v1/checkout', { body: { creator: 'alex', amount: 10, supporter: { type: 'user', id: viewer.subject } } });
        assert.strictEqual(relayed.status, 201, relayed.text);
    });

    await check('health, ready, release.json, metrics and the Events deliveries are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await t.call('GET', '/api/health', { token: null })).status, 200);
            assert.notStrictEqual((await t.call('GET', '/api/ready', { token: null })).status, 429);
            assert.strictEqual((await t.call('GET', '/release.json', { token: null })).status, 200);
            assert.strictEqual((await t.call('GET', '/metrics', { token: null })).status, 200);
            assert.notStrictEqual((await t.deliver({ event_id: `evt_limits_${i}`, event_type: 'test.nothing', version: 1 }, { seq: i + 1 })).status, 429);
        }
    });

    await check('refusals are logged (the caller, never a token) and counted in tips_rate_limited_total', async () => {
        assert.ok(t.logs.some((l) => l === `[Tips] limit tips.read: user:${viewer.subject} refused, over 3 per minute`), t.logs.join('\n'));
        assert.ok(t.logs.some((l) => l === `[Tips] limit tips.payment: user:${viewer.subject} refused, over 20 per minute`));
        assert.ok(!t.logs.some((l) => /Bearer|eyJ/.test(l)), 'no token in the log');
        const m = (await t.call('GET', '/metrics', { token: null })).text;
        assert.ok(/tips_rate_limited_total\{limit="tips.read",window="minute"\} 1/.test(m), m.split('\n').filter((l) => l.includes('rate_limited')).join('\n'));
        assert.ok(/tips_rate_limited_total\{limit="tips.payment",window="minute"\} 1/.test(m));
    });

    await check('who is counted', () => {
        assert.strictEqual(actor({ principal: { kind: 'service', sub: 'svc:live' } }), 'svc:live');
        assert.strictEqual(actor({ principal: { kind: 'user', subject: 'usr_a' } }), 'user:usr_a');
        assert.strictEqual(actor({ principal: { kind: 'anonymous' }, ip: '203.0.113.9' }), 'ip:203.0.113.9');
    });

    await t.close();
    done();
})();
