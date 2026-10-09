'use strict';

/**
 * Account export and deletion → Tips (ADR-033; openvibe-sdk/account-data). A person is here as a creator, a supporter
 * or a moderator.
 *
 *   creator      their settings and page (creator_tip_profiles), overlays, overlay tokens (hashes only, never exported)
 *                and alert history, moderator list and invitations are deleted. The tips they received, the paid
 *                messages and media requests on them, their goals (contributions reference them) and their moderation
 *                log are money and accountability records: kept, counted as retained, so Billing's books and the
 *                totals still reconcile.
 *   supporter    interactions.erase(), the erasure Tips already offers at POST /me/erase: the money record stays and the
 *                person goes (subject, name, message, TTS text, media link, checkout reference, stored API answers,
 *                overlay payloads, unsent events), each erased interaction emits tips.interaction.erased with
 *                `redacts`; one still waiting for its payment is kept and counted. The export is interactions.exportFor().
 *   moderator    their moderator rows go; the moderation log keeps naming them (the creator's accountability).
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

const money = 'money records: Billing\'s books and the creators\' totals must still reconcile';

const TABLES = [
    { table: 'creator_tip_profiles', subject: 'creator_subject', file: 'creator-profile.json', order: 'updated_at' },
    { table: 'overlay_deliveries', subject: 'creator_subject', file: null },
    { table: 'overlay_tokens', subject: 'creator_subject', file: 'overlay-tokens.json', columns: ['id', 'scopes', 'config_id', 'label', 'created_at', 'last_used_at', 'revoked_at'] },
    { table: 'overlay_configs', subject: 'creator_subject', file: 'overlay-configs.json', columns: ['id', 'kind', 'name', 'settings', 'goal_id', 'created_at', 'updated_at'] },
    { table: 'tip_moderators', subject: 'creator_subject', file: 'moderators.json', columns: ['moderator_subject', 'name', 'created_at', 'removed_at'] },
    { table: 'tip_moderators', subject: 'moderator_subject', file: 'moderating.json', columns: ['creator_subject', 'created_at', 'removed_at'], kind: 'tip_moderators' },
    { table: 'tip_moderator_invites', subject: 'creator_subject', file: null },
    { table: 'tip_moderator_invites', subject: 'used_by', file: null, erase: { anonymize: {} } },
    { table: 'tip_goals', subject: 'creator_subject', file: 'goals.json', columns: ['id', 'title', 'description', 'target_amount', 'currency', 'status', 'reached_at', 'closed_at', 'created_at'], erase: { keep: 'goal contributions (money records) reference them' } },
    { table: 'tip_interactions', subject: 'creator_subject', file: 'tips-received.json', columns: ['id', 'kind', 'amount', 'currency', 'payment_state', 'settlement', 'origin', 'created_at', 'settled_at', 'reversed_at'], erase: { keep: money } },
    { table: 'paid_messages', subject: 'creator_subject', file: null, erase: { keep: money } },
    { table: 'paid_media_requests', subject: 'creator_subject', file: null, erase: { keep: money } },
    { table: 'tip_moderation_log', subject: 'creator_subject', file: null, erase: { keep: 'the creator\'s moderation log, kept for accountability' } },
    { table: 'tip_moderation_log', subject: 'actor', file: null, erase: { keep: 'the moderation log names the moderator, for the creator\'s accountability' }, kind: 'tip_moderation_log' },
];

/** The account-data handle over Tips' domain (server/domain/index.js): db and interactions. */
function create({ domain, log = console } = {}) {
    return createAccountData({
        db: domain.db, service: 'tips', tables: TABLES, log,
        note: 'Payments, balances and refunds are OpenVibe.Billing\'s records. Tips you sent keep their amount for the creator\'s books, without your name or message.',
        extraExport: async (db, subject) => [{ name: 'tips-sent.json', content: await domain.interactions.exportFor(subject) }],
        // Inside the erase transaction: interactions.erase() opens a savepoint in it (openvibe-sdk/db ambient).
        extraErase: async (t, subjects, counts) => {
            for (const subject of subjects) {
                const r = await domain.interactions.erase(subject);
                counts.add(counts.retained, 'tombstones', r.erased);
                counts.add(counts.retained, 'tip_interactions_pending', r.kept_pending);
                counts.add(counts.erased, 'api_idempotency', r.stored_answers_removed);
            }
        },
    });
}

module.exports = { create, TABLES, TOPICS };
