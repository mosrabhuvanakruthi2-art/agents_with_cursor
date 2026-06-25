'use strict';
require('../src/config/env');
const axios = require('axios');
const outlookClient = require('../src/clients/outlookClient');

async function test() {
  const TARGET = 'alex@gajha.com';
  const token  = await outlookClient.getAccessToken(TARGET);
  const uid    = encodeURIComponent(TARGET);
  const G      = 'https://graph.microsoft.com/v1.0';
  const hdr    = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const BACKDATE = '2022-06-15T09:00:00Z';

  // Test 1: extended props in the initial POST body
  console.log('\n--- Test 1: extended props in POST ---');
  const r1 = await axios.post(
    `${G}/users/${uid}/mailFolders/inbox/messages`,
    {
      subject: 'ExtProp in POST test',
      body: { contentType: 'text', content: 'test' },
      from:   { emailAddress: { address: 'granger@gajha.com', name: 'Granger' } },
      sender: { emailAddress: { address: 'granger@gajha.com', name: 'Granger' } },
      toRecipients: [{ emailAddress: { address: 'alex@gajha.com', name: 'Alex' } }],
      isRead: true,
      singleValueExtendedProperties: [
        { id: 'Integer 0x0e07', value: '1' },
        { id: 'SystemTime 0x0e06', value: BACKDATE },
        { id: 'SystemTime 0x0039', value: BACKDATE },
      ],
    },
    { headers: hdr }
  );
  console.log('isDraft:', r1.data.isDraft, '| receivedDateTime:', r1.data.receivedDateTime);

  // Test 2: sendMail from granger to alex (non-draft delivery)
  console.log('\n--- Test 2: sendMail from granger to alex ---');
  const msgId = `<bulk-test-${Date.now()}@gajha.com>`;
  const senderUid = encodeURIComponent('granger@gajha.com');
  const sToken = await outlookClient.getAccessToken('granger@gajha.com');
  const sHdr = { Authorization: 'Bearer ' + sToken, 'Content-Type': 'application/json' };

  await axios.post(
    `${G}/users/${senderUid}/sendMail`,
    {
      message: {
        subject: 'sendMail test to alex',
        body: { contentType: 'text', content: 'sent mail test' },
        toRecipients: [{ emailAddress: { address: 'alex@gajha.com', name: 'Alex' } }],
        internetMessageHeaders: [{ name: 'X-Bulk-MsgID', value: msgId }],
      },
      saveToSentItems: false,
    },
    { headers: sHdr }
  );
  console.log('sendMail done. Searching for delivered msg...');

  // Wait a moment for delivery
  await new Promise(r => setTimeout(r, 3000));

  // Search in alex's inbox for the delivered message
  const search = await axios.get(
    `${G}/users/${uid}/mailFolders/inbox/messages?$filter=subject eq 'sendMail test to alex'&$orderby=receivedDateTime desc&$top=1&$select=id,isDraft,receivedDateTime,subject`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const msgs = search.data.value;
  if (msgs.length > 0) {
    console.log('Delivered! isDraft:', msgs[0].isDraft, '| receivedDateTime:', msgs[0].receivedDateTime);
    // Now patch timestamp
    const id = msgs[0].id;
    await axios.patch(`${G}/users/${uid}/messages/${id}`,
      { singleValueExtendedProperties: [
        { id: 'SystemTime 0x0e06', value: BACKDATE },
        { id: 'SystemTime 0x0039', value: BACKDATE },
      ]},
      { headers: hdr });
    const c = await axios.get(
      `${G}/users/${uid}/messages/${id}?$select=isDraft,receivedDateTime`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    console.log('After timestamp patch: isDraft:', c.data.isDraft, '| receivedDateTime:', c.data.receivedDateTime);
  } else {
    console.log('Message not found in inbox yet');
  }
}

test().catch(e => console.error('Error:', e.response?.status, JSON.stringify(e.response?.data) || e.message));
