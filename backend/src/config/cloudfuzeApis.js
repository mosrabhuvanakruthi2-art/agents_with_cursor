/**
 * CloudFuze migration-tool APIs, organized BY PRODUCT.
 *
 * Single source of truth for "which CloudFuze server + endpoints each product uses",
 * so you don't have to hunt across client files. Each product runs against a DIFFERENT
 * CloudFuze server with its own subscriber account:
 *
 *   mail     → devemail.cloudfuze.com     (Gmail / Outlook)
 *   content  → qarelease.cloudfuze.com    (Box / Drive / SharePoint / OneDrive)
 *   message  → s2cdev.cloudfuze.com       (Slack / Teams / Google Chat)
 *
 * Server URL + credentials are resolved at runtime:
 *   - mail/content → from env (config/env.js, sourced from backend/.env)
 *   - message      → per migration from the wizard (context.migrationServer*),
 *                    falling back to env. NO hardcoded message account.
 *
 * The endpoint paths below mirror the client implementations (the actual callers):
 *   mail     → clients/devemailClient.js + clients/migrationClient.js
 *   content  → clients/migrationClient.js (content path)
 *   message  → clients/chatMigrationClient.js
 * Invoked by: agents/migration/MigrationAgent.js (mail+content),
 *             agents/message/MessageMigrationAgent.js (message).
 */
const env = require('./env');

const CLOUDFUZE_APIS = {
  mail: {
    label: 'Mail — Gmail / Outlook',
    serverEnv: 'MIGRATION_API_URL',
    get server() { return env.MIGRATION_API_URL; },
    credEnv: ['MIGRATION_API_BASIC_AUTH', 'MIGRATION_API_BEARER_TOKEN', 'MIGRATION_API_USERNAME', 'MIGRATION_API_PASSWORD'],
    client: 'clients/devemailClient.js + clients/migrationClient.js',
    agent: 'agents/migration/MigrationAgent.js',
    endpoints: {
      login:        'POST /auth/user',                       // → App JWT
      register:     'POST /mail/register',                   // App JWT → Mail JWT
      initiate:     'POST /mail/move/initiate',              // start mail migration
      reports:      'GET  /mail/reports',                    // poll progress
      clouds:       'GET  /mail/clouds',                     // connected cloud accounts
      validateUser: 'GET  /users/validateUser?searchUser=',  // validate subscriber
    },
  },

  content: {
    label: 'Content — Box / Drive / SharePoint / OneDrive',
    serverEnv: 'CONTENT_MIGRATION_SERVER_URL',
    get server() { return env.CONTENT_MIGRATION_SERVER_URL; },
    credEnv: ['CONTENT_MIGRATION_SERVER_EMAIL', 'CONTENT_MIGRATION_SERVER_PASSWORD'],
    client: 'clients/migrationClient.js (content path)',
    agent: 'agents/migration/MigrationAgent.js',
    endpoints: {
      login:     'POST /email/app/login | /entapp/login',  // email + MD5 password
      initiate:  'POST /content/initiate',                 // start content migration
      multiUser: 'POST /move/newmultiuser/create',         // multi-user content job
      reports:   'GET  /mail/reports',                     // poll progress
    },
  },

  message: {
    label: 'Message — Slack / Teams / Google Chat',
    serverEnv: 'CHAT_MIGRATION_API_URL (or per-migration from the wizard)',
    get server() { return env.CHAT_MIGRATION_API_URL; },
    credEnv: ['(wizard) migrationServerUrl/Email/Password/BasicAuth', 'CHAT_MIGRATION_API_* (fallback)'],
    client: 'clients/chatMigrationClient.js',
    agent: 'agents/message/MessageMigrationAgent.js',
    endpoints: {
      login:           'POST /auth/user',                                  // → userId
      clouds:          'GET  /users/{userId}/get/all/cloud',               // Slack/Teams/Chat clouds
      validateUser:    'GET  /users/validateUser?searchUser=',             // validate subscriber
      listChannels:    'GET  /messagemove/get/slack/channel',              // channels (+ channelDate)
      listDMs:         'GET  /messagemove/get/slackdms',                   // DMs
      initiateChannel: 'POST /messagemove/create/messagemove/custom',      // start channel migration
      initiateDM:      'POST /messagemove/create (directOrGroupMessage=true)', // start DM migration
      reports:         'GET  /messagemove/get/moveJob',                    // job status / reports
      closeJobs:       'POST /messagemove/close',                          // close completed jobs
    },
  },
};

/** Convenience: resolve the API map for a product key ('mail' | 'content' | 'message'). */
function apisFor(product) {
  return CLOUDFUZE_APIS[product] || null;
}

module.exports = { CLOUDFUZE_APIS, apisFor };
