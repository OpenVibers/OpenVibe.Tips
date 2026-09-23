'use strict';

/**
 * Chat delivery seam. An adapter delivers one effect of a settled interaction to the product that
 * owns the chat room, TTS queue or media queue:
 *
 *   adapter = { name, async deliver(job) → { ref? } }     throw to fail; err.permanent = true stops retries
 *   job     = { delivery_id, effect: 'chat_line'|'paid_message'|'tts'|'media_request', test,
 *               creator: SubjectRef, supporter: { name, subject? }, interaction: { id, kind, amount, currency, message },
 *               text, tts?: { text, voice }, media?: { url }, highlight_seconds?, target?: EntityRef }
 *
 * Adapters (TIPS_CHAT_ADAPTER):
 *   live-chat  OpenVibe.Live's /internal/tips/deliveries — the existing donation path (broadcast to the
 *              channel room + global, saved as a 'donation' chat message, the alert sound); see
 *              docs/live-patch.diff. Used until OpenVibe.Chat exposes a public paid-message API.
 *   test       records jobs in memory (development, tests, and simulations when no chat target should
 *              hear a test)
 *   none       no chat effects are created at all
 *
 * A delivery failure is retried with backoff and finally recorded as failed on the effect; it never
 * touches the interaction's payment state (the money is Billing's and already settled).
 */
const { createLiveChatAdapter } = require('./live-chat');

function createTestAdapter({ name = 'test' } = {}) {
    const jobs = [];
    const state = { failWith: null, permanent: false };
    return {
        name,
        jobs,
        state,
        async deliver(job) {
            if (state.failWith) {
                const e = new Error(state.failWith);
                e.permanent = state.permanent;
                throw e;
            }
            jobs.push(job);
            return { ref: { adapter: name, n: jobs.length } };
        },
    };
}

function createAdapters(config, { fetchImpl } = {}) {
    const adapters = { test: createTestAdapter() };
    if (config.chat.adapter === 'live-chat') adapters['live-chat'] = createLiveChatAdapter(config, { fetchImpl });
    return adapters;
}

module.exports = { createAdapters, createTestAdapter };
