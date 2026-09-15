/**
 * Probe which SharePoint tenant/site the sharefile -> sharepoint destination actually lives in.
 *
 * READ-ONLY. App-only Graph GETs against /sites only. Writes nothing, migrates nothing.
 *
 * Why this exists: getMsTenant() maps an email domain to a tenant and falls back to
 * GRAPH_TENANT_ID when the domain is unknown. `granger@gajha.com` is unknown, so every
 * destination read for the sharefile -> sharepoint combination was silently issued against
 * CloudFuze's own tenant (filefuze.sharepoint.com) — which is why the destination
 * did not resolve. gajha.com is its own tenant and it serves trydemos.sharepoint.com.
 *
 * Usage (from backend/):
 *   node scripts/probe-sharepoint-site.js [/sites/PathA] [/sites/PathB] ...
 */
const axios = require('axios');
const env = require('../src/config/env');
const { getAppAccessToken } = require('../src/clients/outlookClient');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// gajha.com's tenant id, from its public OIDC discovery document.
const GAJHA_TENANT = '0de6d210-ac94-461d-a935-4f6c105239a4';

const PATHS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/sites/QA', '/sites/VATICA', '/sites/Vatica'];

async function get(url, token) {
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
}

function brief(data) {
  const e = data?.error;
  if (e) return `${e.code}: ${String(e.message).slice(0, 140)}`;
  return JSON.stringify(data).slice(0, 200);
}

(async () => {
  const token = await getAppAccessToken(GAJHA_TENANT);
  console.log(`tenant gajha.com (${GAJHA_TENANT}) — token OK`);

  const root = await get(`${GRAPH}/sites/root`, token);
  const hostname = root.data?.siteCollection?.hostname;
  console.log(`/sites/root -> ${root.status} hostname=${hostname} webUrl=${root.data?.webUrl}`);

  for (const p of PATHS) {
    const site = await get(`${GRAPH}/sites/${hostname}:${p}`, token);
    if (site.status !== 200) {
      console.log(`\n${p} -> ${site.status} ${brief(site.data)}`);
      continue;
    }
    const siteId = site.data.id;
    console.log(`\n${p} -> 200  id=${siteId}`);

    const drive = await get(`${GRAPH}/sites/${siteId}/drive`, token);
    console.log(`   drive -> ${drive.status} ${drive.status === 200 ? `name="${drive.data.name}"` : brief(drive.data)}`);

    const kids = await get(`${GRAPH}/sites/${siteId}/drive/root/children?$top=50&$select=name,folder,file`, token);
    if (kids.status !== 200) {
      console.log(`   root children -> ${kids.status} ${brief(kids.data)}`);
      continue;
    }
    const items = kids.data.value || [];
    console.log(`   root children -> ${items.length}`);
    for (const i of items.slice(0, 30)) console.log(`      ${i.folder ? '[dir] ' : '      '}${i.name}`);
  }
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
