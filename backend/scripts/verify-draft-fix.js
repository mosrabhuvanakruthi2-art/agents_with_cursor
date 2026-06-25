'use strict';

require('dotenv').config();

const axios         = require('axios');
const outlookClient = require('../src/clients/outlookClient');
const env           = require('../src/config/env');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ALEX       = 'alex@qatestagent.com';

async function getAppToken() {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId:     env.GRAPH_CLIENT_ID_2,
      clientSecret: env.GRAPH_CLIENT_SECRET_2,
      authority:    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2}`,
    },
  });
  const r = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  return r.accessToken;
}

async function fetchMessageBySubject(token, email, subject, folder = 'inbox') {
  const uid     = encodeURIComponent(email);
  const safeSubj = subject.replace(/'/g, "''");
  // Wait briefly for Exchange to index the new message
  await new Promise((r) => setTimeout(r, 3000));
  const res = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders/${folder}/messages` +
    `?$filter=${encodeURIComponent(`subject eq '${safeSubj}'`)}&$select=id,subject,isDraft,isRead,receivedDateTime&$top=5`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  const messages = res.data.value || [];
  return messages[0] || null;
}

async function run() {
  console.log('='.repeat(60));
  console.log('  verify-draft-fix — checking isDraft after createMessageInFolder');
  console.log('='.repeat(60));

  const token = await getAppToken();

  // ── Test 1: Inbox message (should appear as received, not draft) ──────────
  console.log('\nTest 1: Insert into INBOX');
  const run   = Date.now();
  const subj1 = `[VERIFY-DRAFT-${run}] Inbox message from Ben`;
  await outlookClient.createMessageInFolder(ALEX, 'inbox', {
    subject:      subj1,
    body:         { contentType: 'HTML', content: '<p>This should appear as a received email, NOT a draft.</p>' },
    from:         { emailAddress: { address: 'ben@qatestagent.com', name: 'Ben QA' } },
    sender:       { emailAddress: { address: 'ben@qatestagent.com', name: 'Ben QA' } },
    toRecipients: [{ emailAddress: { address: ALEX, name: 'Alex QA' } }],
    isRead: false,
    isDraft: false,
  });
  console.log(`  Waiting for Exchange to index…`);
  const fetched1 = await fetchMessageBySubject(token, ALEX, subj1, 'inbox');
  if (!fetched1) { console.log('  ✗ FAIL — message not found in inbox'); }
  else {
    console.log(`  isDraft    : ${fetched1.isDraft}   (want: false)`);
    console.log(`  isRead     : ${fetched1.isRead}   (want: false)`);
    console.log(`  received   : ${fetched1.receivedDateTime}`);
    if (fetched1.isDraft === false) console.log('  ✓ PASS — not a draft');
    else                            console.log('  ✗ FAIL — still a draft');
  }

  // ── Test 2: Sent Items message ────────────────────────────────────────────
  console.log('\nTest 2: Insert into SENT ITEMS');
  const subj2 = `[VERIFY-DRAFT-${run}] Sent message to Ben`;
  await outlookClient.createMessageInFolder(ALEX, 'sentitems', {
    subject:      subj2,
    body:         { contentType: 'HTML', content: '<p>This should appear as a sent email, NOT a draft.</p>' },
    from:         { emailAddress: { address: ALEX, name: 'Alex QA' } },
    sender:       { emailAddress: { address: ALEX, name: 'Alex QA' } },
    toRecipients: [{ emailAddress: { address: 'ben@qatestagent.com', name: 'Ben QA' } }],
    isRead: true,
    isDraft: false,
  });
  console.log(`  Waiting for Exchange to index…`);
  const fetched2 = await fetchMessageBySubject(token, ALEX, subj2, 'sentitems');
  if (!fetched2) { console.log('  ✗ FAIL — message not found in sentitems'); }
  else {
    console.log(`  isDraft    : ${fetched2.isDraft}   (want: false)`);
    console.log(`  isRead     : ${fetched2.isRead}   (want: true)`);
    if (fetched2.isDraft === false) console.log('  ✓ PASS — not a draft');
    else                            console.log('  ✗ FAIL — still a draft');
  }

  console.log('\n' + '='.repeat(60));
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});