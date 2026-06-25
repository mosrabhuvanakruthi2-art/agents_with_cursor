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
      clientId: env.GRAPH_CLIENT_ID_2, clientSecret: env.GRAPH_CLIENT_SECRET_2,
      authority: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2}`,
    },
  });
  const r = await cca.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  return r.accessToken;
}

async function run() {
  console.log('='.repeat(60));
  console.log('  verify-message-id — checking internetMessageId after EWS inject');
  console.log('='.repeat(60));

  const run   = Date.now();
  const subj  = `[MSGID-TEST-${run}] Check Message-ID`;

  const result = await outlookClient.createMessageInFolder(ALEX, 'inbox', {
    subject:      subj,
    body:         { contentType: 'HTML', content: '<p>Checking that Message-ID is set by EWS inject.</p>' },
    from:         { emailAddress: { address: 'alice.johnson@external.com', name: 'Alice Johnson' } },
    toRecipients: [{ emailAddress: { address: ALEX } }],
    isRead: false, isDraft: false,
  });

  console.log(`  EWS returned internetMessageId: ${result.internetMessageId}`);

  await new Promise(r => setTimeout(r, 3000));
  const token = await getAppToken();
  const uid   = encodeURIComponent(ALEX);
  const safeSubj = subj.replace(/'/g, "''");
  const res = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders/inbox/messages` +
    `?$filter=${encodeURIComponent(`subject eq '${safeSubj}'`)}&$select=id,subject,isDraft,internetMessageId&$top=1`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  const msg = (res.data.value || [])[0];
  if (!msg) { console.log('  ✗ Message not found'); return; }

  console.log(`  Graph internetMessageId  : ${msg.internetMessageId}`);
  console.log(`  isDraft                  : ${msg.isDraft}`);

  if (msg.internetMessageId) console.log('  ✓ PASS — Message-ID present');
  else                       console.log('  ✗ FAIL — Message-ID missing');

  console.log('='.repeat(60));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });