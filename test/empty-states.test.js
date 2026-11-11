'use strict';
// Empty pages on OpenVibe.Tips are the shared kit's empty state, with the next action as a kit button.
const assert = require('assert');
const views = require('../server/web/pages');

const goals = views.goalsPage({ profile: { display_name: 'Alma', handle: 'alma', page: {} }, goals: [] });
assert.ok(goals.includes('class="ovk-empty"'), 'no goals is a kit empty state');
assert.ok(goals.includes('No goals yet'), goals.slice(0, 200));

const receipts = views.receiptsPage({ rows: [], next: null, flash: null });
assert.ok(receipts.includes('class="ovk-empty"'), 'no tips is a kit empty state');
assert.ok(receipts.includes('No tips yet'));
assert.ok(/class="ovk-btn[^"]*"[^>]*href="\/"/.test(receipts), 'Find a creator is a kit button');

const layout = require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'web', 'layout.js'), 'utf8');
assert.ok(layout.includes("ovServe.url('kit.css')"), 'the shell loads kit.css');

console.log('empty states: Tips goals and receipts use kit.empty');
