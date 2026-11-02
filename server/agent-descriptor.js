'use strict';
// What openvibe.tips tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the JSON API, the llms.txt/sitemap machine map, and
// the auth that API accepts (service client-credentials tokens and Network user tokens). No OpenAPI
// document or documentation page is published, so neither is named.
module.exports = {
    id: 'tips',
    name: 'OpenVibe.Tips',
    purpose: 'Creator support on the OpenVibe network: tips, goals, paid messages, text-to-speech and media requests, sounds and stream overlays, with money moved by OpenVibe.Billing.',
    home: 'https://openvibe.tips',
    site: 'openvibe.tips',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC', 'service token'],
    },
};
