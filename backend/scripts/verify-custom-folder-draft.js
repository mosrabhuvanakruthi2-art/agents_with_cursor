'use strict';
require('dotenv').config();

const axios         = require('axios');
const outlookClient = require('../src/clients/outlookClient');
const env           = require('../src/config/env');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ALEX = 'alex@qatestagent.com';
const BEN  = 'ben@qatestagent.com';

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

async function getOrCreateFolder(token, parentFolderName, childName) {
  const uid = encodeURIComponent(ALEX);
  // find parent
  const parentRes = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders?$filter=${encodeURIComponent(`displayName eq '${parentFolderName}'`)}&$select=id,displayName`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  let parentId = (parentRes.data.value || [])[0]?.id;
  if (!parentId) {
    const cr = await axios.post(`${GRAPH_BASE}/users/${uid}/mailFolders`,
      { displayName: parentFolderName },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    parentId = cr.data.id;
    console.log(`  Created parent folder: ${parentFolderName}`);
  }

  if (!childName) return { id: parentId, name: parentFolderName };

  // find/create child
  const childRes = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders/${parentId}/childFolders?$filter=${encodeURIComponent(`displayName eq '${childName}'`)}&$select=id,displayName`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  let childId = (childRes.data.value || [])[0]?.id;
  if (!childId) {
    const cr = await axios.post(`${GRAPH_BASE}/users/${uid}/mailFolders/${parentId}/childFolders`,
      { displayName: childName },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    childId = cr.data.id;
    console.log(`  Created child folder: ${parentFolderName}/${childName}`);
  }
  return { id: childId, name: `${parentFolderName}/${childName}` };
}

async function findBySubjectInFolder(token, folderId, subject) {
  const uid   = encodeURIComponent(ALEX);
  const safe  = subject.replace(/'/g, "''");
  await new Promise(r => setTimeout(r, 2500));
  const res = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders/${folderId}/messages` +
    `?$filter=${encodeURIComponent(`subject eq '${safe}'`)}&$select=id,subject,isDraft,isRead&$top=1`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  return (res.data.value || [])[0] || null;
}

async function run() {
  const ts   = Date.now();
  const subj = `[CUSTOM-FOLDER-DRAFT-${ts}] EWS inject test`;

  console.log('='.repeat(60));
  console.log('  verify-custom-folder-draft — isDraft for custom folder EWS inject');
  console.log('='.repeat(60));

  const token = await getAppToken();
  const folder = await getOrCreateFolder(token, 'QA-VerifyCustom', null);
  console.log(`\n  Target folder: ${folder.name} (${folder.id.substring(0, 20)}...)\n`);

  await outlookClient.createMessageInFolder(ALEX, folder.id, {
    subject:      subj,
    body:         { contentType: 'text', content: 'Testing EWS inject into custom folder.' },
    from:         { emailAddress: { address: BEN, name: 'Ben' } },
    toRecipients: [{ emailAddress: { address: ALEX } }],
    isRead: false, isDraft: false,
  });

  console.log('  Waiting for Exchange to index…');
  const msg = await findBySubjectInFolder(token, folder.id, subj);

  if (!msg) {
    console.log('  ✗ FAIL — message not found in custom folder');
  } else {
    console.log(`  isDraft : ${msg.isDraft}   (want: false)`);
    console.log(`  isRead  : ${msg.isRead}   (want: false)`);
    if (msg.isDraft === false) console.log('  ✓ PASS — not a draft in custom folder');
    else                       console.log('  ✗ FAIL — still a draft in custom folder');
  }
  console.log('='.repeat(60));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });