'use strict';
// Track O: GET /metrics answers direct loopback callers only, labels requests by route template and
// carries the Tips gauges; /api/ready is 503 only when the database fails, and a missing Billing,
// Events or Network key degrades it instead.
const assert = require('assert');
const nodeHttp = require('http');
const { boot, check, done } = require('./helpers/app');

function get(base, p, headers = {}) {
    return new Promise((resolve, reject) => nodeHttp.get(base + p, { headers }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject));
}

(async () => {
    const t = await boot();
    await t.creator('alex');

    await check('/api/ready: every check reports; db is the only required one', async () => {
        const r = await t.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.status, 'ready');
        assert.strictEqual(r.json.service, 'tips');
        assert.deepStrictEqual(Object.keys(r.json.checks), ['db', 'network_jwks', 'billing', 'events']);
        for (const [name, c] of Object.entries(r.json.checks)) {
            assert.strictEqual(c.status, 'ok', `${name}: ${c.error}`);
            assert.strictEqual(c.required, name === 'db', name);
            assert.strictEqual(typeof c.latency_ms, 'number');
            assert.ok(Date.parse(c.checked_at));
        }
        assert.ok(r.json.events_outbox && r.json.pending_deliveries);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    });

    await check('/metrics: 404 through a proxy, golden signals by route template and Tips gauges direct', async () => {
        await t.call('GET', '/api/v1/profiles/alex', { token: null });
        await t.call('GET', '/api/no/such/12345', { token: null });
        for (const h of [{ 'X-Forwarded-For': '203.0.113.7' }, { 'X-Real-IP': '203.0.113.7' }, { 'CF-Connecting-IP': '203.0.113.7' }]) {
            const m = await get(t.base, '/metrics', h);
            assert.strictEqual(m.status, 404, JSON.stringify(h));
            assert.ok(!m.body.includes('http_requests_total'));
        }
        const m = await get(t.base, '/metrics');
        assert.strictEqual(m.status, 200);
        const text = m.body;
        assert.ok(/http_requests_total\{method="GET",route="\/api\/v1\/profiles\/:creator",status_class="2xx"\} 1\n/.test(text), 'route template, not the handle');
        assert.ok(/http_requests_total\{method="GET",route="unmatched",status_class="4xx"\} 1\n/.test(text));
        assert.ok(!/route="[^"]*(alex|12345)/.test(text), 'no concrete path in any label');
        assert.ok(/http_request_duration_seconds_bucket\{method="GET",route="\/api\/ready",le="\+Inf"\} 1\n/.test(text));
        assert.ok(/\nhttp_requests_in_flight \d+\n/.test(text));
        assert.ok(/\nprocess_resident_memory_bytes \d+\n/.test(text));
        assert.ok(/release_info\{service="tips",release="[^"]+"\} 1\n/.test(text));
        for (const e of ['chat_line', 'paid_message', 'tts', 'media_request', 'overlay_alert']) assert.ok(new RegExp(`tips_effects_pending\\{effect="${e}"\\} 0\\n`).test(text), e);
        assert.ok(/\ntips_effects_due 0\n/.test(text));
        assert.ok(/\ntips_overlay_deliveries_pending 0\n/.test(text));
        assert.ok(/\ntips_outbox_pending \d+\n/.test(text));
    });

    await check('an overlay SSE stream is not a request sample', async () => {
        const reader = await t.sse('/overlay/not-a-token/events');
        reader.close();
        const text = (await get(t.base, '/metrics')).body;
        assert.ok(!text.includes('/overlay/:token/events') && !text.includes('not-a-token'));
    });

    await t.close();

    await check('Billing down and the events relay off: still ready (200), degraded, and says why', async () => {
        const d = await boot({ env: { EVENTS_URL: '' } });
        d.billing.state.down = true;
        const r = await d.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.ready, true);
        assert.strictEqual(r.json.status, 'degraded');
        assert.deepStrictEqual(r.json.degraded, ['billing', 'events']);
        assert.strictEqual(r.json.checks.billing.error, 'answered HTTP 503');
        assert.match(r.json.checks.events.error, /events relay off/);
        await d.close();
    });

    await check('a broken database makes the service unready (503); /metrics still answers', async () => {
        const d = await boot();
        d.db.close();
        const r = await d.call('GET', '/api/ready', { token: null });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.ready, false);
        assert.strictEqual(r.json.status, 'not_ready');
        assert.deepStrictEqual(r.json.failed, ['db']);
        assert.strictEqual(r.json.pending_deliveries, null);
        const m = await get(d.base, '/metrics');
        assert.strictEqual(m.status, 200);
        assert.ok(!/\ntips_overlay_deliveries_pending \d/.test(m.body), 'a gauge that cannot be read is left out, not invented');
        try { await d.close(); } catch { /* the database is already closed */ }
    });

    done();
})();
