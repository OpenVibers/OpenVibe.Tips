'use strict';

/**
 * Members-only posts: the posts a creator writes for the members of their OpenVibe.VIP tiers.
 *
 * A post names the tiers it is for (the Billing tiers of that creator's VIP plans) and carries the
 * title, the creator's Markdown and its safe HTML. Who may read it is never stored: it is answered by
 * the entitlement check (OpenVibe.VIP's answer for member → creator, which is Billing's truth) together
 * with the tier the member holds.
 *
 * Reading rules:
 *   - the list of posts never carries a body; the body is served only after the entitlement check;
 *   - a member reads a post written for their tier or for a lower one;
 *   - a signed-out visitor, a non-member and a member of another tier get the title, the tiers it needs
 *     and a way to join — never the body;
 *   - a hidden post is not served at all (not its body, not its title).
 */
const { sql } = require('openvibe-sdk/db');
const { fail, prefixedId, iso, json, text } = require('../util');
const { renderMarkdown } = require('./markdown');

const MAX_TIERS = 10;

function createPosts(ctx) {
    const { db } = ctx;

    const byId = async (id) => (id ? await db.maybe(sql`SELECT * FROM creator_posts WHERE id = ${String(id)}`) : null);
    /** The creator's posts (published only, unless the caller may moderate). */
    const rows = async ({ creatorSubject, includeHidden = false }) => {
        const st = includeHidden ? ['published', 'hidden'] : ['published'];
        return await db.many(sql`SELECT * FROM creator_posts WHERE creator_subject = ${String(creatorSubject || '')} AND status = ANY(${st}) ORDER BY published_at DESC, created_at DESC`);
    };
    /** Every creator's posts, newest first (the moderation list). */
    const recent = async ({ limit = 50 } = {}) => await db.many(sql`SELECT * FROM creator_posts ORDER BY created_at DESC LIMIT ${Number(limit)}`);

    /** The tiers of one post, as numbers. */
    const tiersOf = (post) => {
        // A jsonb column comes back parsed; an older row may still carry the text.
        const raw = post && post.tiers;
        const list = Array.isArray(raw) ? raw : json(raw, []);
        return Array.isArray(list) ? list.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_TIERS).sort((a, b) => a - b) : [];
    };

    /**
     * The tier a member holds: the plan their membership was bought under (VIP's plan of that
     * creator); a membership made elsewhere (Billing sells those at tier 1) is tier 1.
     */
    function memberTier(entitlement, plans) {
        const planId = entitlement && entitlement.membership ? entitlement.membership.plan_id : null;
        if (!planId) return 1;
        const plan = (plans || []).find((p) => p && p.id === planId);
        const tier = plan ? Number(plan.tier) : 0;
        return Number.isInteger(tier) && tier >= 1 ? tier : 1;
    }

    /**
     * May this reader read this post? → { unlocked, reason, tier }.
     * The entitlement is VIP's answer (Billing's truth, projected); anything VIP cannot confirm is
     * refused, so a membership that ended never opens a post.
     */
    async function access({ post, memberSubject, creatorSubject, plans = null, entitlement = null }) {
        const tiers = tiersOf(post);
        if (!memberSubject) return { unlocked: false, reason: 'signed_out', tier: null };
        const ent = entitlement || await ctx.vip.entitlement({ subject: memberSubject, creator: creatorSubject });
        if (!ent || ent.active !== true || ent.status !== 'active') return { unlocked: false, reason: 'not_a_member', tier: null, entitlement: ent };
        const tier = memberTier(ent, plans);
        if (!tiers.length || !tiers.some((t) => tier >= t)) return { unlocked: false, reason: 'other_tier', tier, entitlement: ent };
        return { unlocked: true, reason: 'member', tier, entitlement: ent };
    }

    /** The post as it is shown, with the body only when the reader may read it. */
    function present(post, { unlocked = false, tier = null } = {}) {
        const shown = {
            id: post.id, creator: { type: 'user', id: post.creator_subject }, title: post.title, tiers: tiersOf(post),
            status: post.status, created_at: post.created_at, updated_at: post.updated_at, published_at: post.published_at || null,
            hidden_at: post.hidden_at || null, hidden_by: post.hidden_by || null, hide_reason: post.hide_reason || null,
            locked: !unlocked, reader_tier: tier,
        };
        if (unlocked) { shown.body = post.body; shown.body_html = post.body_html; }
        return shown;
    }

    /**
     * The posts as a page or an API shows them: the title and the tiers for everyone, the body only
     * for a member of a tier that reads it (the creator reads their own).
     */
    async function view({ creatorSubject, memberSubject = null, plans = null, owner = false }) {
        const list = await rows({ creatorSubject });
        const out = [];
        for (const row of list) {
            const a = owner ? { unlocked: true, tier: null } : await access({ post: row, memberSubject, creatorSubject, plans });
            out.push({
                id: row.id, title: row.title, tiers: tiersOf(row), published_at: row.published_at,
                unlocked: !!a.unlocked, locked: !a.unlocked, body_html: a.unlocked ? row.body_html : null, reader_tier: a.tier || null,
            });
        }
        return out;
    }

    /**
     * Write a post for the members of one or more of the creator's tiers.
     * The tiers must be tiers the creator sells on OpenVibe.VIP, so every member of a tier can join
     * it and a "Become a member" link always leads somewhere.
     */
    async function create({ creatorSubject, title, body, tiers, actor = null }) {
        const cleanTitle = text(title, 'title', 140);
        const cleanBody = text(body, 'body', 20000);
        if (!cleanTitle) fail(422, 'tips.invalid_input', 'title is required');
        if (!cleanBody) fail(422, 'tips.invalid_input', 'body is required');
        const wanted = Array.isArray(tiers) ? tiers : (tiers == null || tiers === '' ? [] : [tiers]);
        const numbers = [...new Set(wanted.map((t) => Number(t)).filter((t) => Number.isInteger(t) && t >= 1 && t <= MAX_TIERS))].sort((a, b) => a - b);
        if (!numbers.length) fail(422, 'tips.invalid_input', 'choose at least one tier for the post');
        const offered = await ctx.vip.tiers(creatorSubject);
        if (!offered.length) fail(422, 'tips.post_no_tiers', 'publish a plan on OpenVibe.VIP first: a post is written for the members of a tier');
        const unknown = numbers.filter((t) => !offered.includes(t));
        if (unknown.length) fail(422, 'tips.post_unknown_tier', `you do not sell tier ${unknown.join(', ')}`);
        const at = iso(ctx.now());
        const id = prefixedId('cpost', ctx.now());
        await db.one(sql`INSERT INTO creator_posts (id, creator_subject, title, body, body_html, tiers, status, created_at, updated_at, published_at)
            VALUES (${id}, ${String(creatorSubject)}, ${cleanTitle}, ${cleanBody}, ${renderMarkdown(cleanBody)}, ${sql.json(numbers)}, 'published', ${at}, ${at}, ${at}) RETURNING *`);
        return await byId(id);
    }

    /** Hide a post (the creator's own call, or a moderator): it is not served at all any more. */
    async function hide(id, { actor = null, reason = null } = {}) {
        const post = await byId(id);
        if (!post) fail(404, 'tips.post_not_found', 'no post ' + id);
        if (post.status === 'hidden') return post;
        const at = iso(ctx.now());
        await db.one(sql`UPDATE creator_posts SET status = 'hidden', hidden_at = ${at}, hidden_by = ${actor}, hide_reason = ${reason ? String(reason).slice(0, 300) : null}, updated_at = ${at} WHERE id = ${String(id)} RETURNING *`);
        return await byId(id);
    }

    /** Show a hidden post again (the creator, or a moderator). */
    async function unhide(id, { actor = null } = {}) {
        const post = await byId(id);
        if (!post) fail(404, 'tips.post_not_found', 'no post ' + id);
        if (post.status !== 'hidden') return post;
        const at = iso(ctx.now());
        await db.one(sql`UPDATE creator_posts SET status = 'published', hidden_at = NULL, hidden_by = NULL, hide_reason = NULL, updated_at = ${at} WHERE id = ${String(id)} RETURNING *`);
        return await byId(id);
    }

    return { byId, rows, recent, create, hide, unhide, present, access, view, tiersOf, memberTier, MAX_TIERS };
}

module.exports = { createPosts, MAX_TIERS };
