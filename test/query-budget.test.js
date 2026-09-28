'use strict';
// The hot list routes run a bounded number of queries, whatever the page size (no N+1): the receipts
// and creator lists (GET /api/v1/interactions, the hottest), goals, the supporters page and an
// overlay's /state. Counted on the database handle (db.stats().queries) around one request each.
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const { billing } = t;
    const alex = await t.creator('alex', { settings: { page: { supporters_page: true, supporters_messages: true, goal_supporters: true } } });
    const fans = ['ann', 'bob', 'cat', 'dan', 'eve'].map((n) => t.network.newUser(n));
    for (const f of fans) billing.fund(f.subject, 10_000);
    const tip = (f, body) => t.call('POST', '/api/v1/checkout', { user: f, body: { creator: 'alex', amount: 10, ...body } });
    const goals = [];
    for (const title of ['Desk', 'Chair', 'Lamp']) goals.push((await t.call('POST', '/api/v1/goals', { user: alex, body: { title, target_amount: 5000 } })).json.goal);
    // Several tips per supporter, messages, goal contributions: every list has many rows.
    for (let k = 0; k < 3; k++) for (const f of fans) assert.strictEqual((await tip(f, { message: `tip ${k} from ${f.username}`, goal_id: goals[k].id })).status, 201);
    const token = (await t.call('POST', '/api/v1/overlay-tokens', { user: alex, body: { scopes: ['alerts', 'goals'] } })).json.secret;

    /** Queries one request runs. */
    async function queries(method, p, opts) {
        const before = t.db.stats().queries;
        const r = await t.call(method, p, opts);
        assert.strictEqual(r.status, 200, `${p}: ${r.text}`);
        return { n: t.db.stats().queries - before, r };
    }

    await check('GET /api/v1/interactions (the creator\'s list, with effects): 3 queries for 1 row or 15', async () => {
        const one = await queries('GET', '/api/v1/interactions?as=creator&limit=1', { user: alex });
        const all = await queries('GET', '/api/v1/interactions?as=creator&limit=50', { user: alex });
        assert.strictEqual(one.r.json.interactions.length, 1);
        assert.strictEqual(all.r.json.interactions.length, 15);
        assert.ok(all.r.json.interactions.every((i) => Array.isArray(i.effects) && i.effects.length >= 1));
        assert.deepStrictEqual([one.n, all.n], [3, 3], 'the page, the creators\' filters, the effects');
    });

    await check('GET /api/v1/interactions (a supporter\'s receipts; a service\'s view of a creator): bounded too', async () => {
        const mine = await queries('GET', '/api/v1/interactions', { user: fans[0] });
        assert.strictEqual(mine.r.json.interactions.length, 3);
        assert.strictEqual(mine.n, 2, 'the page and the filters (no effects for a supporter)');
        const svc = await queries('GET', '/api/v1/interactions?creator=alex&limit=50', { cap: ['tips.interaction.list'] });
        assert.strictEqual(svc.r.json.interactions.length, 15);
        assert.strictEqual(svc.n, 4, 'the creator, the page, the filters, the effects');
    });

    await check('goals, the supporters page and an overlay\'s state: a fixed number of queries for any number of rows', async () => {
        const pub = await queries('GET', '/api/v1/goals?creator=alex', { token: null });
        assert.strictEqual(pub.r.json.goals.length, 3);
        assert.ok(pub.r.json.goals.every((g) => g.supporters.length === 5), 'each goal lists its supporters');
        assert.strictEqual(pub.n, 4, 'the profile, the goals, their totals, their supporters');
        const sup = await queries('GET', '/api/v1/profiles/alex/supporters', { token: null });
        assert.strictEqual(sup.r.json.leaderboard.length, 5);
        assert.strictEqual(sup.r.json.recent.length, 15);
        assert.strictEqual(sup.n, 3, 'the profile, the leaderboard, the recent messages');
        const before = t.db.stats().queries;
        const state = await (await fetch(`${t.base}/overlay/${token}/state`)).json();
        assert.strictEqual(state.alerts.length, 15);
        assert.strictEqual(state.goals.length, 3);
        assert.strictEqual(t.db.stats().queries - before, 4, 'the token, the goals, their totals, the alerts');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
