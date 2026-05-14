/**
 * test-no-delivery.js
 *
 * Verifies that createMessageInFolder does NOT deliver emails to other users.
 *
 * Test 1 — CC leak:
 *   Insert a message into Alex's inbox with Ben CC'd.
 *   Ben's inbox count must be unchanged after 10 s.
 *
 * Test 2 — Sent Items / To leak:
 *   Insert a message into Alex's Sent Items with Ben in toRecipients.
 *   Ben's inbox count must be unchanged after 10 s.
 *
 * Run:
 *   node scripts/test-no-delivery.js
 *
 * Requires a working .env with GRAPH_CLIENT_ID_2 / GRAPH_CLIENT_SECRET_2 /
 * GRAPH_TENANT_ID_2 (qatestagent.com is in GRAPH_TENANT_2_DOMAINS).
 */

'use strict';

require('dotenv').config();

const axios          = require('axios');
const outlookClient  = require('../src/clients/outlookClient');
const env            = require('../src/config/env');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ALEX       = 'alex@qatestagent.com';
const BEN        = 'ben@qatestagent.com';
const DELAY_MS   = 10_000;   // wait for Exchange to deliver (if it were still sending)

// ── helpers ──────────────────────────────────────────────────────────────────

function pass(msg) { console.log(`  ✓ PASS  ${msg}`); }
function fail(msg) { console.error(`  ✗ FAIL  ${msg}`); process.exitCode = 1; }

async function getInboxCount(email) {
  const { ConfidentialClientApplication } = require('@azure/msal-node');
  const creds = {
    auth: {
      clientId:     env.GRAPH_CLIENT_ID_2,
      clientSecret: env.GRAPH_CLIENT_SECRET_2,
      authority:    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2}`,
    },
  };
  const app   = new ConfidentialClientApplication(creds);
  const result = await app.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  const token  = result.accessToken;
  const uid    = encodeURIComponent(email);
  const res    = await axios.get(
    `${GRAPH_BASE}/users/${uid}/mailFolders/inbox`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
  );
  return res.data.totalItemCount;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── test runner ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('='.repeat(60));
  console.log('  test-no-delivery — verifying no emails go to other users');
  console.log(`  Source : ${ALEX}`);
  console.log(`  Watcher: ${BEN}  (should receive 0 new emails)`);
  console.log('='.repeat(60));

  // ── pre-flight: snapshot Ben's inbox ─────────────────────────────────────
  let benBefore;
  try {
    benBefore = await getInboxCount(BEN);
    console.log(`\n  Ben's inbox before: ${benBefore} message(s)\n`);
  } catch (err) {
    console.error(`  ERROR reading Ben's inbox: ${err.message}`);
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: Insert inbox message with Ben in ccRecipients
  // ─────────────────────────────────────────────────────────────────────────
  console.log('Test 1: CC leak check');
  console.log('  Inserting message into Alex\'s inbox with Ben CC\'d…');
  try {
    await outlookClient.createMessageInFolder(ALEX, 'inbox', {
      subject:      '[QA-no-delivery] Test 1 — CC leak check',
      body:         { contentType: 'text', content: 'This message should appear ONLY in Alex\'s inbox. Ben is CC\'d but must NOT receive it.' },
      from:         { emailAddress: { address: BEN, name: 'Ben QA' } },
      toRecipients: [{ emailAddress: { address: ALEX, name: 'Alex QA' } }],
      ccRecipients: [{ emailAddress: { address: BEN,  name: 'Ben QA'  } }],
      isRead: false, isDraft: false,
    });
    console.log(`  Message inserted. Waiting ${DELAY_MS / 1000}s for any Exchange delivery…`);
    await sleep(DELAY_MS);

    const benAfter1 = await getInboxCount(BEN);
    console.log(`  Ben's inbox after Test 1: ${benAfter1} message(s)`);

    if (benAfter1 === benBefore) {
      pass('Ben\'s inbox count unchanged — CC did not trigger delivery');
    } else {
      fail(`Ben received ${benAfter1 - benBefore} new message(s) — CC leak detected!`);
    }
  } catch (err) {
    fail(`Test 1 error: ${err.message}`);
  }

  console.log();

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Insert Sent Items message with Ben in toRecipients
  // ─────────────────────────────────────────────────────────────────────────
  console.log('Test 2: Sent Items / To leak check');
  console.log('  Inserting message into Alex\'s Sent Items with Ben as toRecipient…');

  const benBeforeT2 = await getInboxCount(BEN);

  try {
    await outlookClient.createMessageInFolder(ALEX, 'sentitems', {
      subject:      '[QA-no-delivery] Test 2 — Sent Items To leak check',
      body:         { contentType: 'text', content: 'This message should appear ONLY in Alex\'s Sent Items. Ben is in toRecipients but must NOT receive it.' },
      from:         { emailAddress: { address: ALEX, name: 'Alex QA' } },
      toRecipients: [{ emailAddress: { address: BEN, name: 'Ben QA' } }],
      isRead: true, isDraft: false,
    });
    console.log(`  Message inserted. Waiting ${DELAY_MS / 1000}s for any Exchange delivery…`);
    await sleep(DELAY_MS);

    const benAfter2 = await getInboxCount(BEN);
    console.log(`  Ben's inbox after Test 2: ${benAfter2} message(s)`);

    if (benAfter2 === benBeforeT2) {
      pass('Ben\'s inbox count unchanged — Sent Items toRecipients did not trigger delivery');
    } else {
      fail(`Ben received ${benAfter2 - benBeforeT2} new message(s) — Sent Items leak detected!`);
    }
  } catch (err) {
    fail(`Test 2 error: ${err.message}`);
  }

  console.log();
  console.log('='.repeat(60));
  if (process.exitCode === 1) {
    console.error('  RESULT: ONE OR MORE TESTS FAILED');
  } else {
    console.log('  RESULT: ALL TESTS PASSED');
  }
  console.log('='.repeat(60));
}

runTests().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});