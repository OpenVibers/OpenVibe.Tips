'use strict';
/**
 * The front page: who is live on OpenVibe (clients/live-now.js, Live's public stream list, cached a minute, never
 * Live's AI text, nothing when Live fails), its questions with their FAQPage JSON-LD, no filler.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { createLiveNow } = require('../server/clients/live-now');

(async () => {
    await check('live-now keeps only what a card needs, the most watched first, and caches for a minute', async () => {
        let calls = 0;
        let clock = 1_000_000;
        const fetchImpl = async (url) => {
            calls++;
            assert.strictEqual(url, 'https://live.test/api/streams');
            return { ok: true, json: async () => ({ streams: [
                { is_live: 1, username: 'quiet', display_name: 'Quiet One', title: 'Reading', category: 'books', viewer_count: 1, ai_overview: 'never shown' },
                { is_live: 1, username: 'busy_1', display_name: 'Busy', title: 'Speedrun', chosen_category: 'gaming', viewer_count: 40 },
                { is_live: 1, is_nsfw: 1, username: 'nsfw', viewer_count: 99 },
                { is_live: 0, username: 'offline', viewer_count: 5 },
                { is_live: 1, username: 'bad name!', viewer_count: 7 },
            ] }) };
        };
        const live = createLiveNow({ config: { liveNow: true, liveUrl: 'https://live.test' }, fetchImpl, now: () => clock, log: { warn() {} } });
        const list = await live.list();
        assert.deepStrictEqual(list.map((x) => x.username), ['busy_1', 'quiet'], 'live, safe-for-work, valid names, most watched first');
        assert.deepStrictEqual(list[0], { username: 'busy_1', name: 'Busy', title: 'Speedrun', category: 'gaming', viewers: 40, started_at: null, url: 'https://live.test/@busy_1' });
        assert.ok(!JSON.stringify(list).includes('never shown'), 'no AI text');
        await live.list();
        assert.strictEqual(calls, 1, 'cached');
        clock += 61_000;
        await live.list();
        assert.strictEqual(calls, 2, 'refreshed after a minute');
        const down = createLiveNow({ config: { liveNow: true, liveUrl: 'https://live.test' }, fetchImpl: async () => { throw new Error('down'); }, log: { warn() {} } });
        assert.deepStrictEqual(await down.list(), [], 'Live down: nothing, no error');
        const off = createLiveNow({ config: { liveNow: false, liveUrl: 'https://live.test' }, fetchImpl: async () => { throw new Error('never called'); } });
        assert.deepStrictEqual(await off.list(), []);
    });

    const t = await boot({ appOpts: { liveNow: { list: async () => [{ username: 'busy_1', name: 'Busy', title: 'Speedrun', category: 'gaming', viewers: 40, url: 'https://openvibe.live/@busy_1' }] } } });
    await check('the home shows who is live, what creators get, the services and the questions (FAQPage JSON-LD)', async () => {
        const r = await fetch(`${t.base}/`);
        const text = await r.text();
        const body = text.slice(text.indexOf('<main'));
        assert.strictEqual(r.status, 200);
        assert.strictEqual((text.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
        assert.ok(body.includes('id="live"') && body.includes('<a href="https://openvibe.live/@busy_1"><strong>Busy</strong></a>') && body.includes('gaming · 40 watching'));
        assert.ok(body.includes('For creators') && body.includes('Overlays for any stream'));
        assert.ok(body.includes('<li>Ko-fi</li>') && body.includes('<li>StreamElements</li>'), 'the services a creator can link');
        const ld = [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
        const faq = ld.find((x) => x['@type'] === 'FAQPage');
        assert.ok(faq && faq.mainEntity.length === 6);
        const missing = faq.mainEntity.filter((q) => !body.includes(`<summary>${q.name.replace(/'/g, '&#39;')}</summary>`));
        assert.deepStrictEqual(missing, [], 'every question is on the page');
        assert.doesNotMatch(body, /coming soon/i);
    });
    await t.close();
    done();
})();
