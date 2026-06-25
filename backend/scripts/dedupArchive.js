'use strict';
/**
 * dedupArchive.js (v2 — EWS)
 * Removes duplicate messages from ron@qatestagent.com In-Place Archive.
 * Graph API returns 404 on archiveRoot (separate Exchange mailbox), so we use
 * EWS ExchangeImpersonation with the 'archiveroot' distinguished folder instead.
 * Groups messages by internetMessageId; keeps the oldest copy, hard-deletes the rest.
 * Usage: cd backend && node scripts/dedupArchive.js
 */
require('../src/config/env');
const { ConfidentialClientApplication } = require('@azure/msal-node');
const axios          = require('axios');
const env            = require('../src/config/env');
const outlookClient  = require('../src/clients/outlookClient');

const TARGET      = 'ron@qatestagent.com';
const EWS_URL     = 'https://outlook.office365.com/EWS/Exchange.asmx';
const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE   = 1000;   // FindItem / Graph $top page size
const DEL_BATCH   = 100;    // DeleteItem batch size

// Optional: set ARCHIVE_GUID env var to the Exchange ArchiveGuid
// (from PowerShell: Get-Mailbox ron@qatestagent.com | Select ArchiveGuid)
// When set, the script uses Graph API with the GUID instead of EWS.
const ARCHIVE_GUID = process.env.ARCHIVE_GUID || '';

// ── EWS token — uses tenant 2 credentials because qatestagent.com is in GRAPH_TENANT_2_DOMAINS ──
const ewsCache = { token: null, expiresAt: 0 };
async function getEwsToken() {
  if (ewsCache.token && Date.now() < ewsCache.expiresAt) return ewsCache.token;
  // Determine correct tenant: use tenant 2 if qatestagent.com is in GRAPH_TENANT_2_DOMAINS
  const targetDomain = TARGET.split('@')[1]?.toLowerCase();
  const isT2 = env.GRAPH_TENANT_2_DOMAINS?.includes(targetDomain);
  const clientId     = isT2 ? env.GRAPH_CLIENT_ID_2     : env.GRAPH_CLIENT_ID;
  const clientSecret = isT2 ? env.GRAPH_CLIENT_SECRET_2 : env.GRAPH_CLIENT_SECRET;
  const tenantId     = isT2 ? env.GRAPH_TENANT_ID_2     : env.GRAPH_TENANT_ID;
  console.log(`  [EWS token] using tenant ${isT2 ? '2' : '1'} (${tenantId?.substring(0,8)}…) for ${TARGET}`);
  const cca = new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
  });
  const result = await cca.acquireTokenByClientCredential({
    scopes: ['https://outlook.office365.com/.default'],
  });
  ewsCache.token     = result.accessToken;
  ewsCache.expiresAt = Date.now() + (result.expiresOn - Date.now()) * 0.9;
  return ewsCache.token;
}

// ── EWS helper: wrap body in SOAP envelope + retry on 429/503 ───────────────
async function ewsPost(bodyXml) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const token = await getEwsToken();
      const soap  = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    <t:ExchangeImpersonation>
      <t:ConnectingSID><t:SmtpAddress>${TARGET}</t:SmtpAddress></t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;
      const res = await axios.post(EWS_URL, soap, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml; charset=utf-8' },
        timeout: 60000,
      });
      const xml = String(res.data);
      if (xml.includes('ResponseClass="Error"') && !xml.includes('ErrorCalendarIsCancelledItem')) {
        const errMatch = xml.match(/<m:MessageText>([^<]+)<\/m:MessageText>/);
        const codeMatch = xml.match(/<m:ResponseCode>([^<]+)<\/m:ResponseCode>/);
        // Ignore ErrorItemNotFound in bulk deletes (item already gone)
        if (codeMatch && codeMatch[1] === 'ErrorItemNotFound') return xml;
        throw new Error(`EWS error: ${codeMatch?.[1] || ''} — ${errMatch?.[1] || xml.substring(0, 300)}`);
      }
      return xml;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 || status === 503) {
        const wait = parseInt(err.response?.headers?.['retry-after'] || '15', 10) * 1000;
        console.log(`    [${status}] Throttled — waiting ${wait / 1000}s…`);
        await new Promise(r => setTimeout(r, wait));
      } else if (attempt === 7) {
        if (err.response?.data) console.error('EWS response body:', String(err.response.data).substring(0, 800));
        throw err;
      } else {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
}

// ── Get archive root folder via GetFolder on 'archiveroot' distinguished ID ─
async function getArchiveRoot() {
  const xml = await ewsPost(`
    <m:GetFolder>
      <m:FolderShape>
        <t:BaseShape>Default</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="folder:TotalCount"/>
          <t:FieldURI FieldURI="folder:ChildFolderCount"/>
        </t:AdditionalProperties>
      </m:FolderShape>
      <m:FolderIds>
        <t:DistinguishedFolderId Id="archiveroot">
          <t:Mailbox><t:EmailAddress>${TARGET}</t:EmailAddress></t:Mailbox>
        </t:DistinguishedFolderId>
      </m:FolderIds>
    </m:GetFolder>`);

  const idMatch    = xml.match(/FolderId Id="([^"]+)" ChangeKey="([^"]+)"/);
  const nameMatch  = xml.match(/<t:DisplayName>([^<]+)<\/t:DisplayName>/);
  const countMatch = xml.match(/<t:TotalCount>([^<]+)<\/t:TotalCount>/);
  if (!idMatch) throw new Error(`GetFolder archiveroot failed:\n${xml.substring(0, 600)}`);
  return {
    id:         idMatch[1],
    name:       nameMatch ? nameMatch[1] : 'Archive Root',
    totalCount: countMatch ? parseInt(countMatch[1], 10) : 0,
  };
}

// ── Discover all subfolders under a folder via FindFolder(Deep) ─────────────
async function getAllSubfolders(parentId) {
  const folders = [];
  let offset = 0, hasMore = true;

  while (hasMore) {
    const xml = await ewsPost(`
      <m:FindFolder Traversal="Deep">
        <m:FolderShape>
          <t:BaseShape>Default</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="folder:TotalCount"/>
          </t:AdditionalProperties>
        </m:FolderShape>
        <m:IndexedPageFolderView MaxEntriesReturned="500" Offset="${offset}" BasePoint="Beginning"/>
        <m:ParentFolderIds><t:FolderId Id="${parentId}"/></m:ParentFolderIds>
      </m:FindFolder>`);

    const lastMatch = xml.match(/RootFolder[^>]+IncludesLastItemInRange="([^"]+)"/);
    hasMore = lastMatch ? lastMatch[1] === 'false' : false;

    // Match any folder type: Folder, CalendarFolder, ContactsFolder, etc.
    const anyFolderRx = /<t:\w*Folder>([\s\S]*?)<\/t:\w*Folder>/g;
    let m;
    while ((m = anyFolderRx.exec(xml)) !== null) {
      const block     = m[1];
      const idMatch   = block.match(/FolderId Id="([^"]+)" ChangeKey="([^"]+)"/);
      const nameMatch = block.match(/<t:DisplayName>([^<]+)<\/t:DisplayName>/);
      const cntMatch  = block.match(/<t:TotalCount>([^<]+)<\/t:TotalCount>/);
      if (idMatch) {
        folders.push({
          id:         idMatch[1],
          name:       nameMatch ? nameMatch[1] : 'Unknown',
          totalCount: cntMatch  ? parseInt(cntMatch[1], 10) : 0,
        });
      }
    }
    offset += 500;
  }
  return folders;
}

// ── Fetch all messages in a folder via FindItem (paginated) ─────────────────
async function getAllMessages(folderId) {
  let offset = 0, hasMore = true;
  const messages = [];

  while (hasMore) {
    const xml = await ewsPost(`
      <m:FindItem Traversal="Shallow">
        <m:ItemShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="message:InternetMessageId"/>
            <t:FieldURI FieldURI="item:DateTimeReceived"/>
          </t:AdditionalProperties>
        </m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="${PAGE_SIZE}" Offset="${offset}" BasePoint="Beginning"/>
        <m:ParentFolderIds><t:FolderId Id="${folderId}"/></m:ParentFolderIds>
      </m:FindItem>`);

    const lastMatch = xml.match(/RootFolder[^>]+IncludesLastItemInRange="([^"]+)"/);
    hasMore = lastMatch ? lastMatch[1] === 'false' : false;

    // Match Message and CalendarItem blocks (CalendarItems have no InternetMessageId — skipped via fallback)
    const itemRx = /<t:(?:Message|CalendarItem|Contact|Task)>([\s\S]*?)<\/t:(?:Message|CalendarItem|Contact|Task)>/g;
    let m;
    while ((m = itemRx.exec(xml)) !== null) {
      const block     = m[1];
      const idMatch   = block.match(/ItemId Id="([^"]+)" ChangeKey="([^"]+)"/);
      const dateMatch = block.match(/<t:DateTimeReceived>([^<]+)<\/t:DateTimeReceived>/);
      const imidMatch = block.match(/<t:InternetMessageId>([^<]*)<\/t:InternetMessageId>/);
      if (idMatch) {
        // Decode XML entities in InternetMessageId, strip angle brackets
        const rawImid = imidMatch ? imidMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
        const imid    = rawImid ? rawImid.replace(/^<|>$/g, '') : `nomid::${idMatch[1]}`;
        messages.push({
          ewsId:      idMatch[1],
          changeKey:  idMatch[2],
          receivedAt: dateMatch ? new Date(dateMatch[1]) : new Date(0),
          imid,
        });
      }
    }

    offset += PAGE_SIZE;
    if (offset % 3000 === 0) process.stdout.write(`\r    fetched ${messages.length}…`);
  }
  return messages;
}

// ── Hard-delete a list of items via EWS DeleteItem in batches ───────────────
async function deleteItems(items) {
  for (let i = 0; i < items.length; i += DEL_BATCH) {
    const batch      = items.slice(i, i + DEL_BATCH);
    const idsXml     = batch.map(it => `<t:ItemId Id="${it.ewsId}" ChangeKey="${it.changeKey}"/>`).join('');
    await ewsPost(`
      <m:DeleteItem DeleteType="HardDelete" SendMeetingCancellations="SendToNone">
        <m:ItemIds>${idsXml}</m:ItemIds>
      </m:DeleteItem>`);
    const done = Math.min(i + DEL_BATCH, items.length);
    process.stdout.write(`\r    deleted ${done}/${items.length}…`);
  }
  if (items.length > 0) process.stdout.write('\n');
}

// Folders we must not touch: RecoverableItems hierarchy + system/search folders
const SKIP_FOLDERS = new Set([
  'AllItems',          // virtual search folder spanning everything
  'Recoverable Items', 'Calendar Logging', 'Deletions', 'Purges',
  'SubstrateHolds', 'Versions', 'RecoveryPoints',
  'CrawlerData', 'Common Views', 'Favorites', 'Finder',
  'Freebusy Data', 'ApplicationDataRoot', 'Deferred Action',
  'PeopleConnect', 'SkypeSpacesData', 'SpoolsSearchFolder',
  'Spooler Queue', 'SPOOLS', 'SubstrateFiles', 'SwssItems',
  'ShadowItems', 'Shortcuts', 'ShortNotes', 'Views',
  'Yammer Root', 'YammerData', 'TeamsMeetings', 'TeamsMessages',
  'TeamsMessagesData', 'TeamChatHistory', 'Team Chat',
  'OneNotePagePreviews', 'Schedule', 'To-Do Search', 'Recipient Cache',
]);

function shouldSkip(name) {
  if (SKIP_FOLDERS.has(name)) return true;
  // Skip GUID-named system folders like {06967759-...}
  if (/^\{[0-9a-f-]{36}\}$/i.test(name)) return true;
  // Skip UUID-style folders (Exchange internal)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return true;
  return false;
}

// ── Deduplicate one folder ───────────────────────────────────────────────────
async function deduplicateFolder(folder) {
  if (folder.totalCount === 0) return { kept: 0, deleted: 0 };
  if (shouldSkip(folder.name)) {
    console.log(`  ${folder.name.padEnd(28)} — skipped (system folder)`);
    return { kept: 0, deleted: 0 };
  }
  process.stdout.write(`  ${folder.name.padEnd(28)} (${folder.totalCount}) — fetching…`);

  const messages = await getAllMessages(folder.id);
  process.stdout.write(`\r  ${folder.name.padEnd(28)} fetched ${messages.length}\n`);
  if (messages.length === 0) return { kept: 0, deleted: 0 };

  // Group by normalised internetMessageId
  const groups = new Map();
  for (const msg of messages) {
    if (!groups.has(msg.imid)) groups.set(msg.imid, []);
    groups.get(msg.imid).push(msg);
  }

  // Keep oldest, delete newer duplicates
  const toDelete = [];
  for (const msgs of groups.values()) {
    if (msgs.length <= 1) continue;
    msgs.sort((a, b) => a.receivedAt - b.receivedAt);
    for (let i = 1; i < msgs.length; i++) toDelete.push(msgs[i]);
  }

  if (toDelete.length === 0) {
    console.log(`    → no duplicates found`);
  } else {
    console.log(`    → ${toDelete.length} duplicates — deleting…`);
    await deleteItems(toDelete);
    console.log(`    → kept ${groups.size} unique, deleted ${toDelete.length}`);
  }

  return { kept: groups.size, deleted: toDelete.length };
}

// ── Graph API path (used when ARCHIVE_GUID is set) ───────────────────────────
async function graphGetArchiveFolders() {
  const token = await outlookClient.getAccessToken(TARGET);
  // Try GUID@domain format that Exchange Online uses internally for archive routing
  const tenantDomain = TARGET.split('@')[1];
  const archiveUserId = `${ARCHIVE_GUID}@${tenantDomain}`;
  const uid = encodeURIComponent(archiveUserId);
  const h = { Authorization: `Bearer ${token}` };

  // Get archive root
  let rootFolder;
  try {
    const r = await axios.get(
      `${GRAPH_BASE}/users/${uid}/mailFolders/archiveRoot?$select=id,displayName,totalItemCount,childFolderCount`,
      { headers: h }
    );
    rootFolder = r.data;
  } catch (e) {
    // Some tenants route archive via the user's normal UPN but with a special header
    throw new Error(`Graph archiveRoot with GUID failed (${e.response?.status}): ${JSON.stringify(e.response?.data)?.substring(0, 300)}`);
  }
  console.log(`Archive root: "${rootFolder.displayName}"  (${rootFolder.totalItemCount} items in root)\n`);

  // Discover subfolders recursively
  async function getChildren(parentId) {
    const r = await axios.get(
      `${GRAPH_BASE}/users/${uid}/mailFolders/${parentId}/childFolders?$top=50&$select=id,displayName,totalItemCount,childFolderCount`,
      { headers: h }
    );
    const result = [];
    for (const f of (r.data.value || [])) {
      result.push(f);
      if ((f.childFolderCount || 0) > 0) result.push(...(await getChildren(f.id)));
    }
    return result;
  }
  const subfolders = await getChildren(rootFolder.id);
  return [rootFolder, ...subfolders].map(f => ({
    id: f.id, name: f.displayName, totalCount: f.totalItemCount || 0, _uid: uid, _token: token,
  }));
}

async function graphGetAllMessages(folder) {
  const h = { Authorization: `Bearer ${folder._token}` };
  const uid = encodeURIComponent(folder._uid);
  const messages = [];
  let url = `${GRAPH_BASE}/users/${uid}/mailFolders/${folder.id}/messages?$top=100&$select=id,internetMessageId,receivedDateTime`;
  while (url) {
    const r = await axios.get(url, { headers: h });
    messages.push(...(r.data.value || []));
    url = r.data['@odata.nextLink'];
  }
  return messages;
}

async function graphDeleteMsg(msgId, folder) {
  const h = { Authorization: `Bearer ${folder._token}` };
  const uid = encodeURIComponent(folder._uid);
  await axios.delete(`${GRAPH_BASE}/users/${uid}/messages/${msgId}`, { headers: h });
}

async function deduplicateFolderGraph(folder) {
  if (folder.totalCount === 0) return { kept: 0, deleted: 0 };
  process.stdout.write(`  ${folder.name.padEnd(28)} (${folder.totalCount}) — fetching…`);
  const messages = await graphGetAllMessages(folder);
  process.stdout.write(`\r  ${folder.name.padEnd(28)} fetched ${messages.length}\n`);
  if (messages.length === 0) return { kept: 0, deleted: 0 };

  const groups = new Map();
  for (const msg of messages) {
    const mid = (msg.internetMessageId || `nomid::${msg.id}`).replace(/^<|>$/g, '');
    if (!groups.has(mid)) groups.set(mid, []);
    groups.get(mid).push(msg);
  }
  let deleted = 0;
  for (const msgs of groups.values()) {
    if (msgs.length <= 1) continue;
    msgs.sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime));
    for (let i = 1; i < msgs.length; i++) {
      await graphDeleteMsg(msgs[i].id, folder);
      deleted++;
      if (deleted % 50 === 0) process.stdout.write(`\r    deleted ${deleted}…`);
    }
  }
  if (deleted > 0) process.stdout.write('\n');
  return { kept: groups.size, deleted };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (ARCHIVE_GUID) {
    // ── Graph path: archive GUID provided ────────────────────────────────────
    console.log(`\nUsing ARCHIVE_GUID=${ARCHIVE_GUID} — attempting Graph API path…\n`);
    const allFolders = await graphGetArchiveFolders();
    console.log(`Found ${allFolders.length} archive folder(s):`);
    allFolders.forEach(f => console.log(`  ${f.name.padEnd(30)} ${f.totalCount} items`));
    console.log('');

    let grandKept = 0, grandDeleted = 0;
    const startTime = Date.now();
    for (const folder of allFolders) {
      const { kept, deleted } = await deduplicateFolderGraph(folder);
      grandKept += kept; grandDeleted += deleted;
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Done in ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(`Unique messages kept : ${grandKept}`);
    console.log(`Duplicates deleted   : ${grandDeleted}`);
    return;
  }

  // ── EWS path: requires full_access_as_app Exchange permission ────────────
  console.log(`\nConnecting to In-Place Archive for ${TARGET} via EWS…\n`);
  console.log(`(If this fails with ErrorNonExistentMailbox, the Azure AD app needs`);
  console.log(` full_access_as_app Exchange permission, OR set ARCHIVE_GUID env var.)\n`);

  const archiveRoot = await getArchiveRoot();
  console.log(`Archive root: "${archiveRoot.name}"  (${archiveRoot.totalCount} items in root)\n`);

  const subfolders = await getAllSubfolders(archiveRoot.id);
  const allFolders = [archiveRoot, ...subfolders];
  console.log(`Found ${allFolders.length} archive folder(s):`);
  allFolders.forEach(f => console.log(`  ${f.name.padEnd(30)} ${f.totalCount} items`));
  console.log('');

  let grandKept = 0, grandDeleted = 0;
  const startTime = Date.now();

  for (const folder of allFolders) {
    const { kept, deleted } = await deduplicateFolder(folder);
    grandKept    += kept;
    grandDeleted += deleted;
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done in ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  console.log(`Unique messages kept : ${grandKept}`);
  console.log(`Duplicates deleted   : ${grandDeleted}`);
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
