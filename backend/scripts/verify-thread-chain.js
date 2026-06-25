'use strict';
require('dotenv').config();

const axios         = require('axios');
const outlookClient = require('../src/clients/outlookClient');
const env           = require('../src/config/env');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ALEX = 'alex@qatestagent.com';

async function getAppToken() {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: env.GRAPH_CLIENT_ID_2, clientSecret: env.GRAPH_CLIENT_SECRET_2,
      authority: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2}`,
    },
  });
  const r = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  return r.accessToken;
}

async function findBySubject(token, folder, subject) {
  const uid      = encodeURIComponent(ALEX);
  const safe     = subject.replace(/'/g, "''");
  await new Promise(r => setTimeout(r, 2000));
  const res = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders/${folder}/messages` +
    `?$filter=${encodeURIComponent(`subject eq '${safe}'`)}&$select=id,subject,isDraft,internetMessageId,conversationId&$top=5`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  return (res.data.value || [])[0] || null;
}

async function run() {
  const run = Date.now();
  const threadSubject = `[THREAD-TEST-${run}] QA E2E 4 - Thread Chain Test`;
  const replySubject  = `RE: [THREAD-TEST-${run}] QA E2E 4 - Thread Chain Test`;

  console.log('='.repeat(60));
  console.log('  verify-thread-chain — checking In-Reply-To / References linkage');
  console.log('='.repeat(60));

  // ── Original ──────────────────────────────────────────────────────────────
  console.log('\n1. Creating original (inbox)…');
  const orig = await outlookClient.createMessageInFolder(ALEX, 'inbox', {
    subject:      threadSubject,
    body:         { contentType: 'text', content: 'Thread original message.' },
    from:         { emailAddress: { address: 'ben@qatestagent.com', name: 'Ben' } },
    toRecipients: [{ emailAddress: { address: ALEX } }],
    isRead: true, isDraft: false,
  });
  console.log(`   internetMessageId : ${orig.internetMessageId}`);

  // ── Reply #1 ──────────────────────────────────────────────────────────────
  console.log('2. Creating reply #1 (sentitems)…');
  const r1 = await outlookClient.createMessageInFolder(ALEX, 'sentitems', {
    subject:      replySubject,
    body:         { contentType: 'text', content: 'Reply #1.\n\n> Thread original.' },
    from:         { emailAddress: { address: ALEX } },
    toRecipients: [{ emailAddress: { address: 'ben@qatestagent.com' } }],
    isRead: true, isDraft: false,
    inReplyTo:  orig.internetMessageId,
    references: orig.internetMessageId,
  });
  console.log(`   internetMessageId : ${r1.internetMessageId}`);

  // ── Reply #2 ──────────────────────────────────────────────────────────────
  console.log('3. Creating reply #2 (inbox)…');
  const r2 = await outlookClient.createMessageInFolder(ALEX, 'inbox', {
    subject:      replySubject,
    body:         { contentType: 'text', content: 'Reply #2.\n\n> Reply #1.\n\n> Thread original.' },
    from:         { emailAddress: { address: 'ben@qatestagent.com', name: 'Ben' } },
    toRecipients: [{ emailAddress: { address: ALEX } }],
    isRead: false, isDraft: false,
    inReplyTo:  r1.internetMessageId,
    references: [orig.internetMessageId, r1.internetMessageId].filter(Boolean).join(' '),
  });
  console.log(`   internetMessageId : ${r2.internetMessageId}`);

  // ── Verify via Graph ──────────────────────────────────────────────────────
  console.log('\nFetching messages from Graph to verify…');
  const token = await getAppToken();
  const m0 = await findBySubject(token, 'inbox',     threadSubject);
  const m1 = await findBySubject(token, 'sentitems', replySubject);
  const m2 = await findBySubject(token, 'inbox',     replySubject);

  console.log('\n  Message       | isDraft | conversationId (same = threaded)');
  console.log('  ─────────────────────────────────────────────────────────────');
  [['Original (inbox)', m0], ['Reply#1 (sent)',  m1], ['Reply#2 (inbox)', m2]].forEach(([label, m]) => {
    if (!m) { console.log(`  ${label.padEnd(18)}| NOT FOUND`); return; }
    console.log(`  ${label.padEnd(18)}| ${String(m.isDraft).padEnd(7)} | ${m.conversationId}`);
  });

  const allSameConv = m0 && m1 && m2 && m0.conversationId === m1.conversationId && m1.conversationId === m2.conversationId;
  console.log(allSameConv
    ? '\n  ✓ PASS — all 3 messages share the same conversationId (appear as one thread)'
    : '\n  ✗ FAIL — conversationIds differ (messages appear as separate emails)'
  );
  console.log('='.repeat(60));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });