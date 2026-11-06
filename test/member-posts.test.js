'use strict';
/**
 * The members-only posts of a creator's page: the text is served to a member of a tier that reads it
 * and to nobody else — not in the page, not in the API, not in the machine-readable pages, and not
 * when OpenVibe.VIP cannot answer. A member's page is never left for a shared cache.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { startVip } = require('./helpers/stubs');

const SECRET = 'the secret text of a members-only post';
const JOIN = 'https://openvibe.vip/alice#plan-gold';
const asPost = (title) => ({ title, body: SECRET, tiers: [1] });
/** The posts section of a creator page. */
const section = (html) => (html.split('<section class="posts"')[1] || '').split('</section>')[0];

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
            const grant = () => vip.state.answers.set(member.subject + '|' + creator.subject, {
                status: 'active', active: true, expires_at: new Date(Date.now() + 86400e3).toISOString(),
                membership: { id: 'mem_1', plan_id: 'plan_gold' },
            });
            const revoke = () => vip.state.answers.set(member.subject + '|' + creator.subject, {
                status: 'inactive', active: false, expires_at: null, membership: null,
            });
            grant();

            // The creator publishes a post for tier 1.
            const created = await t.call('POST', '/api/v1/profiles/me/posts', { user: creator, body: asPost('A note for members') });
            assert.equal(created.status, 201, created.text);
            const post = created.json.post;

            // 1. The creator page: the title and the way in, never the text.
            const page = await t.call('GET', '/alice');
            assert.equal(page.status, 200, page.text);
            assert.ok(page.text.includes('A note for members'), 'the title is public');
            assert.ok(!page.text.includes(SECRET), 'the text never reaches a stranger');
            assert.ok(page.text.includes(JOIN), 'the join link is on the card');
            assert.ok(page.text.includes('Become a member'), 'the card offers the way in');

            // 2. The card reads: the title, one quiet line (lock glyph, tier, date), then the button.
            const cards = section(page.text);
            assert.ok(cards.includes('For Tier 1 members'), 'the quiet line names the tier it is written for');
            assert.ok(cards.includes('<svg'), 'the quiet line carries the shared lock glyph');
            assert.ok(/\d{4}-\d{2}-\d{2}/.test(cards), 'the quiet line carries the date');
            assert.ok(!cards.includes('UTC'), 'the date is a day, not a timestamp');
            assert.ok(!cards.includes('Members only'), 'no "Members only" heading');
            assert.ok(!cards.includes('This post is for the members of'), 'no repeated sentence');
            assert.ok(!cards.includes('Posts for the members of a tier'), 'no intro line');

            // 3. The order: the tip form is the page's job and comes first.
            assert.ok(page.text.indexOf('Send Alice something') < page.text.indexOf('<section class="posts"'), 'the tip form comes before the posts');

            // 4. The cache: a shared cache stores by URL and ignores Vary, so a page that depends on
            //    the viewer must be private.
            assert.equal(page.headers.get('cache-control'), 'private, no-cache', 'a stranger\'s page is private');
            assert.ok(String(page.headers.get('vary') || '').includes('Cookie'), 'the page varies by cookie');
            const memberRes = await fetch(t.base + '/alice', { headers: { Cookie: 'ov_token=' + t.network.signUser(member) } });
            const memberHtml = await memberRes.text();
            assert.equal(memberRes.headers.get('cache-control'), 'private, no-cache', 'a member\'s page is private');
            assert.ok(String(memberRes.headers.get('vary') || '').includes('Cookie'));

            // 5. A member reads the text: the same card, the tier in the quiet line, no button.
            assert.ok(memberHtml.includes(SECRET), 'the member reads the text on the page');
            assert.ok(memberHtml.includes('Tier 1 \u00b7'), 'the member sees the tier in the quiet line');
            assert.ok(!memberHtml.includes('Become a member'), 'the member has no button');
            assert.ok(!memberHtml.includes('For Tier 1 members'), 'the member has no locked line');
            // The text never travels in an answer a shared cache may keep.
            assert.equal(memberRes.headers.get('cache-control'), 'private, no-cache');

            // 6. The JSON-LD of the page carries no text.
            const ld = (page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1] || '';
            assert.ok(ld.length > 0, 'the page has its JSON-LD');
            assert.ok(!ld.includes(SECRET), 'the JSON-LD carries no text');

            // 7. The machine-readable pages carry no text either.
            const llms = await t.call('GET', '/llms-full.txt');
            assert.equal(llms.status, 200);
            assert.ok(!llms.text.includes(SECRET), 'llms-full.txt carries no text');
            const sitemap = await t.call('GET', '/sitemap.xml');
            assert.equal(sitemap.status, 200);
            assert.ok(!sitemap.text.includes(SECRET), 'the sitemap carries no text');
            // The Markdown twin of the creator page (the agent layer): the title, never the text.
            const twin = await t.call('GET', '/alice.md');
            assert.ok(!twin.text.includes(SECRET), 'the Markdown twin carries no text');

            // 8. The API list never carries a body; the body route refuses a stranger.
            const list = await t.call('GET', '/api/v1/profiles/alice/posts', { user: stranger });
            assert.equal(list.status, 200, list.text);
            assert.ok(!JSON.stringify(list.json).includes(SECRET), 'the list carries no text');
            assert.equal(list.json.posts.length, 1);
            assert.equal(list.json.posts[0].locked, true);
            assert.equal(list.json.posts[0].join_url, JOIN);
            assert.equal(list.headers.get('cache-control'), 'no-store', 'the API is never cached');
            const refused = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: stranger });
            assert.equal(refused.status, 403, refused.text);
            assert.ok(!refused.text.includes(SECRET));

            // 9. A member reads the text (the API).
            const memberBody = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: member });
            assert.equal(memberBody.status, 200, memberBody.text);
            assert.ok(memberBody.json.post.body.includes(SECRET));

            // 10. A hidden post is not served at all (not its title, not its text).
            const hidden = await t.call('POST', '/api/v1/posts/' + post.id + '/hide', { user: creator });
            assert.equal(hidden.status, 200, hidden.text);
            const gone = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id);
            assert.equal(gone.status, 404);
            const afterHide = await t.call('GET', '/alice');
            assert.ok(!afterHide.text.includes('A note for members'), 'a hidden post is gone from the page');
            assert.ok(!afterHide.text.includes(SECRET));
            const shown = await t.call('POST', '/api/v1/posts/' + post.id + '/unhide', { user: creator });
            assert.equal(shown.status, 200, shown.text);

            // 11. OpenVibe.VIP down: nobody reads the text (it fails closed).
            vip.state.down = true;
            const newcomer = t.network.newUser('dave');
            const downBody = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: newcomer });
            assert.equal(downBody.status, 403, 'without VIP nobody is a member');
            assert.ok(!downBody.text.includes(SECRET));
            vip.state.down = false;

            // 12. A membership that ends: OpenVibe.VIP announces it and the cached grant goes at once.
            const before = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: member });
            assert.equal(before.status, 200, before.text);
            revoke();
            const delivered = await t.deliver({
                event_id: 'evt_01M6R3NC10YJVGSPB8NKZQMCD6',
                event_type: 'vip.membership.changed',
                source: 'vip',
                version: 1,
                timestamp: new Date().toISOString(),
                actor: { type: 'service', id: 'openvibe.vip' },
                subject: { type: 'account', id: member.subject },
                visibility: 'internal',
                payload: { member: { type: 'user', id: member.subject }, creator: { type: 'user', id: creator.subject }, active: false },
            });
            assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
            assert.equal(delivered.json.outcome, 'vip entitlement dropped');
            const after = await t.call('GET', '/api/v1/profiles/alice/posts/' + post.id + '/body', { user: member });
            assert.equal(after.status, 403, 'the cancelled member reads nothing, without waiting for the TTL');
            assert.ok(!after.text.includes(SECRET));
            grant();

            // 13. Many posts: the newest three, then a counted fold that opens in place.
            for (const title of ['Second note', 'Third note', 'Fourth note']) {
                const made = await t.call('POST', '/api/v1/profiles/me/posts', { user: creator, body: asPost(title) });
                assert.equal(made.status, 201, made.text);
            }
            const many = await t.call('GET', '/alice');
            assert.ok(many.text.includes('More posts (1)'), 'the fold counts the rest');
            assert.equal((many.text.match(/<article class="card post">/g) || []).length, 4, 'every card stays in the page');
            const fold = (many.text.split('<summary>More posts (1)</summary>')[1] || '');
            assert.ok(fold.includes('A note for members'), 'the fold carries the older post');
            assert.ok(!many.text.includes('style="display:none'), 'nothing is hidden with display:none');

            // 14. The creator reads their own post in the dashboard.
            const dashRes = await fetch(t.base + '/dashboard', { headers: { Cookie: 'ov_token=' + t.network.signUser(creator) } });
            const dashHtml = await dashRes.text();
            assert.equal(dashRes.status, 200);
            assert.ok(dashHtml.includes('A note for members'), 'the creator sees their post in the dashboard');
            assert.ok(dashHtml.includes(SECRET), 'the creator reads their own text');

            // 15. A tier nobody can join shows no button.
            vip.state.creators.set(creator.subject, { username: 'alice', plans: [{ id: 'plan_gold', slug: 'gold', tier: 1, purchasable: false, current_version: { name: 'Gold' } }] });
            const noPlan = await t.call('GET', '/alice');
            assert.ok(!noPlan.text.includes(JOIN), 'a tier nobody can join shows no button');
            assert.ok(!noPlan.text.includes('Become a member'), 'no button at all when there is no way in');
            assert.ok(section(noPlan.text).includes('For Tier 1 members'), 'the card still says who it is for');
        } finally {
            await t.close();
            await vip.close();
        }
    });
    done();
})();
