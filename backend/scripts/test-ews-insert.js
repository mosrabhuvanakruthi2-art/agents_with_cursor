'use strict';
/**
 * test-ews-insert.js
 *
 * Tests whether our app-only token has EWS access and can insert a non-draft
 * message into a mailbox folder using EWS CreateItem.
 *
 * Run: node scripts/test-ews-insert.js
 */

require('dotenv').config();

const axios = require('axios');
const env   = require('../src/config/env');
const { ConfidentialClientApplication } = require('@azure/msal-node');

const EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';
const TARGET  = 'alex@qatestagent.com';
const SENDER  = 'alice.johnson@external.com';

async function getEwsToken() {
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId:     env.GRAPH_CLIENT_ID_2,
      clientSecret: env.GRAPH_CLIENT_SECRET_2,
      authority:    `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID_2}`,
    },
  });
  // EWS scope is different from Graph
  const r = await cca.acquireTokenByClientCredential({
    scopes: ['https://outlook.office365.com/.default'],
  });
  return r.accessToken;
}

function buildEwsCreateItemSoap(targetMailbox, from, subject, htmlBody) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016" />
    <t:ExchangeImpersonation>
      <t:ConnectingSID>
        <t:PrimarySmtpAddress>${targetMailbox}</t:PrimarySmtpAddress>
      </t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:SavedItemFolderId>
        <t:DistinguishedFolderId Id="inbox" />
      </m:SavedItemFolderId>
      <m:Items>
        <t:Message>
          <t:Subject>${subject}</t:Subject>
          <t:Body BodyType="HTML">${htmlBody}</t:Body>
          <t:From>
            <t:Mailbox><t:EmailAddress>${from}</t:EmailAddress></t:Mailbox>
          </t:From>
          <t:ToRecipients>
            <t:Mailbox><t:EmailAddress>${targetMailbox}</t:EmailAddress></t:Mailbox>
          </t:ToRecipients>
          <t:IsRead>false</t:IsRead>
          <t:ExtendedProperty>
            <t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer" />
            <t:Value>0</t:Value>
          </t:ExtendedProperty>
        </t:Message>
      </m:Items>
    </m:CreateItem>
  </soap:Body>
</soap:Envelope>`;
}

async function run() {
  console.log('='.repeat(60));
  console.log('  test-ews-insert — testing EWS non-draft message injection');
  console.log('='.repeat(60));

  let token;
  try {
    token = await getEwsToken();
    console.log('  ✓ Got EWS Bearer token');
  } catch (err) {
    console.error(`  ✗ Failed to get EWS token: ${err.message}`);
    process.exit(1);
  }

  const soap = buildEwsCreateItemSoap(
    TARGET,
    SENDER,
    '[EWS-TEST] Non-draft injection from alice.johnson@external.com',
    '<p>This message was injected via EWS. It should appear as a <b>real received email</b>, not a draft.</p>'
  );

  try {
    const res = await axios.post(EWS_URL, soap, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '"http://schemas.microsoft.com/exchange/services/2006/messages/CreateItem"',
      },
      timeout: 20000,
    });
    const body = res.data;
    if (body.includes('NoError')) {
      console.log('  ✓ EWS CreateItem succeeded — check Alex\'s inbox, should NOT show [Draft]');
    } else if (body.includes('ErrorAccessDenied') || body.includes('ErrorImpersonationFailed')) {
      console.error('  ✗ EWS impersonation denied — app needs EWS.AccessAsUser.All application permission in Azure AD');
      console.log('\n  Raw response:', body.substring(0, 800));
    } else {
      console.log('  ? Unexpected EWS response:');
      console.log(body.substring(0, 800));
    }
  } catch (err) {
    console.error(`  ✗ EWS request failed: ${err.response?.status} ${err.message}`);
    if (err.response?.data) console.log(String(err.response.data).substring(0, 600));
  }

  console.log('='.repeat(60));
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });