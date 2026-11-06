'use strict';
/**
 * The members-only posts of a creator's page: the text is served to a member of a tier that reads it
 * and to nobody else — not in the page, not in the API, not in the machine-readable pages, and not
 * when OpenVibe.VIP cannot answer.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { startVip } = require('./helpers/stubs');

const SECRET = 'the secret text of a members-only post';
const JOIN = 'https://openvibe.vip/alice#plan-gold';

(async () => {
    await check('the members-only posts', async () => {
    const vip = await startVip();
    // The plans are read on every request in this test, so a plan that stops being joinable is seen.
    const t = await boot({ env: { TIPS_VIP_URL: vip.url, TIPS_VIP_PUBLIC_URL: 'https://openvibe.vip', TIPS_VIP_PLANS_TTL_MS: '0' } });
    try {
        const creator = await t.creator('alice');
        const member = t.network.newUser('bob');
        const stranger = t.network.newUser('carol');
        // The creator sells one tier on VIP; Bob is a member of it, Carol is not.
        vip.state.creators.set(creator.subject, {
            username: 'alice',
            plans: [{ id: 'plan_gold', slug: 'gold', tier: 1, purchasable: true, current_version: { name: 'Gold' } }],
        });
        vip.state.answers.set(member.subject + '|' + creator.subject, {
            status: 'active', active: true, expires_at: new Date(Date.now() + 86400e3).toISOString(),
            membership: { id: 'mem_1', plan_id: 'plan_gold' },
        });

        // The creator publishes a post for tier 1.
        const created = await t.call('POST', '/api/v1/profiles/me/posts', { user: creator, body: { title: 'A note for members', body: SECRET, tiers: [1] } });
        assert.equal(created.status, 201, created.text);
        const post = created.json.post;

        // 1. The creator page: the title and the way in, never the text.
        const page = await t.call('GET', '/alice');
        assert.equal(page.status, 200, page.text);
        assert.ok(page.text.includes('A note for members'), 'the title is public');
        assert.ok(page.text.includes('Members only'), 'the locked card says so');
        assert.ok(page.text.includes(JOIN), 'the join link is on the card');
        assert.ok(!page.text.includes(SECRET), 'the text never reaches a stranger');

        // 2. The machine-readable pages carry no text either.
        const llms = await t.call('GET', '/llms-full.txt');
        assert.equal(llms.status, 200);
        assert.ok(!llms.text.includes(SECRET), 'llms-full.txt carries no text');
        const sitemap = await t.call('GET', '/sitemap.xml');
        assert.equal(sitemap.status, 200);
        assert.ok(!sitemap.text.includes(SECRET), 'the sitemap carries no text');

        // 3. The API list never carries a body; the body route refuses a stranger.
        const list = await t.call('GET', '/api/v1/profiles/alice/posts', { user: stranger });
        assert.equal(list.status, 200, list.text);
        assert.ok(!JSON.stringify(list.json).includes(SECRET), 'the list carries no text');
        assert.equal(list.json.posts.length, 1);
        assert.equal(list.json.posts[0].locked, true);
        assert.equal(list.json.posts[0].join_url, JOIN);
        const refused = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: stranger });
        assert.equal(refused.status, 403, refused.text);
        assert.ok(!refused.text.includes(SECRET));

        // 4. A member reads the text (the API).
        const memberBody = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: member });
        assert.equal(memberBody.status, 200, memberBody.text);
        assert.ok(memberBody.json.post.body.includes(SECRET));

        // 5. A member reads the text on the page; a stranger does not.
        const memberPage = await fetch(t.base + '/alice', { headers: { Cookie: 'ov_token=' + t.network.signUser(member) } });
        const memberHtml = await memberPage.text();
        assert.ok(memberHtml.includes(SECRET), 'the member reads the text on the page');
        assert.ok(!memberHtml.includes('Members only'), 'the member does not see the locked card');
        const strangerPage = await fetch(t.base + '/alice', { headers: { Cookie: 'ov_token=' + t.network.signUser(stranger) } });
        const strangerHtml = await strangerPage.text();
        assert.ok(!strangerHtml.includes(SECRET), 'a stranger never reads the text');
        assert.ok(strangerHtml.includes('Members only'), 'the stranger sees the locked card');

        // 6. A hidden post is not served at all (not its title, not its text).
        const hidden = await t.call('POST', '/api/v1/posts/' + post.id + '/hide', { user: creator });
        assert.equal(hidden.status, 200, hidden.text);
        const gone = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id);
        assert.equal(gone.status, 404);
        const afterHide = await t.call('GET', '/alice');
        assert.ok(!afterHide.text.includes('A note for members'), 'a hidden post is gone from the page');
        assert.ok(!afterHide.text.includes(SECRET));
        const shown = await t.call('POST', '/api/v1/posts/' + post.id + '/unhide', { user: creator });
        assert.equal(shown.status, 200, shown.text);

        // 7. OpenVibe.VIP down: nobody reads the text (it fails closed).
        vip.state.down = true;
        const newcomer = t.network.newUser('dave');
        const downBody = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: newcomer });
        assert.equal(downBody.status, 403, 'without VIP nobody is a member');
        assert.ok(!downBody.text.includes(SECRET));
        vip.state.down = false;

        // 8. The creator reads their own post in the dashboard, and a tier nobody can join shows no button.
        const dash = await fetch(t.base + '/dashboard', { headers: { Cookie: 'ov_token=' + t.network.signUser(creator) } });
        const dashHtml = await dash.text();
        assert.equal(dash.status, 200);
        assert.ok(dashHtml.includes('A note for members'), 'the creator sees their post in the dashboard');
        assert.ok(dashHtml.includes(SECRET), 'the creator reads their own text');
        vip.state.creators.set(creator.subject, { username: 'alice', plans: [{ id: 'plan_gold', slug: 'gold', tier: 1, purchasable: false, current_version: { name: 'Gold' } }] });
        const noPlan = await t.call('GET', '/alice');
        assert.ok(!noPlan.text.includes(JOIN), 'a tier nobody can join shows no button');
        assert.ok(noPlan.text.includes('Members only'), 'the locked card is still there');
    } finally {
        await t.close();
        await vip.close();
    }
    });
    done();
})();
