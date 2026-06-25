/**
 * Xray for Jira **Server / Data Center** — Test Repository REST API.
 *
 * Uses Basic auth (JIRA_USER + JIRA_API_TOKEN). Works with many Jira Cloud setups too for
 * standard Jira REST, but Xray **Test Repository** paths below are the Server/DC style.
 * Jira Cloud + **Xray Cloud** uses GraphQL and different auth; swap this client if needed.
 *
 * @see https://docs.getxray.app/display/XRAY/Tests+-+REST
 */

const axios = require('axios');
const env = require('../config/env');

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function getAuthHeader() {
  const user = env.JIRA_USER;
  const token = env.JIRA_API_TOKEN;
  if (!user || !token) {
    throw new Error('JIRA_USER and JIRA_API_TOKEN must be set in .env for Xray import');
  }
  const basic = Buffer.from(`${user}:${token}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

function createHttp() {
  const baseURL = normalizeBaseUrl(env.JIRA_BASE_URL);
  if (!baseURL) {
    throw new Error('JIRA_BASE_URL must be set in .env (e.g. https://jira.example.com)');
  }
  return axios.create({
    baseURL,
    timeout: 120000,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    validateStatus: () => true,
  });
}

/**
 * Walk nested folder nodes from Xray and produce a flat list for pagination.
 * @param {*} node folder object or array of folders
 * @param {string} parentPath
 * @param {Array<{id:string,name:string,path:string}>} out
 */
function flattenFolderNodes(node, parentPath, out) {
  if (node == null) return;

  if (Array.isArray(node)) {
    for (const item of node) flattenFolderNodes(item, parentPath, out);
    return;
  }

  if (typeof node !== 'object') return;

  const id = node.id != null ? String(node.id) : null;
  const name = node.name != null ? String(node.name) : '';
  const pathField =
    node.testRepositoryPath != null && String(node.testRepositoryPath).length
      ? String(node.testRepositoryPath).replace(/^\//, '')
      : parentPath
        ? `${parentPath}/${name}`.replace(/\/+/g, '/')
        : name || 'Test Repository';

  if (id != null) {
    out.push({
      id,
      name: name || '(root)',
      path: pathField || '/',
    });
  }

  const children = node.folders || node.children || [];
  for (const child of children) {
    flattenFolderNodes(child, pathField, out);
  }
}

/**
 * @returns {{ treeRoot: object|null, flatFolders: Array<{id:string,name:string,path:string}> }}
 */
async function fetchFolderTree(projectKey) {
  const http = createHttp();
  const pk = encodeURIComponent(projectKey);
  const url = `/rest/raven/1.0/api/testrepository/${pk}/folders`;
  const res = await http.get(url);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Jira/Xray auth failed (${res.status}). Check JIRA_USER and JIRA_API_TOKEN.`);
  }
  if (res.status === 404) {
    throw new Error(
      `Xray Test Repository not found (404). Check project key "${projectKey}" and that Xray Server REST is available at ${url}`
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    throw new Error(`Jira/Xray folders request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = res.data;
  const flatFolders = [];
  flattenFolderNodes(data, '', flatFolders);

  const seen = new Set();
  const deduped = [];
  for (const f of flatFolders) {
    const k = `${f.id}:${f.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(f);
  }

  const treeRoot = Array.isArray(data) ? { id: '-1', name: 'Test Repository', folders: data } : data;

  return { treeRoot, flatFolders: deduped };
}

function normalizeTestsPayload(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tests)) return data.tests;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.results)) return data.results;
  return [];
}

/**
 * Paginate tests in a folder (page is 1-based per common Xray behavior).
 */
async function fetchAllTestsInFolder(projectKey, folderId, limit = 100) {
  const http = createHttp();
  const pk = encodeURIComponent(projectKey);
  const fid = encodeURIComponent(folderId);
  const all = [];
  const seenKeys = new Set();
  let page = 1;
  const maxPages = 50000;

  for (;;) {
    if (page > maxPages) {
      throw new Error(`Stopped after ${maxPages} pages in folder ${folderId} — check Xray pagination`);
    }
    const url = `/rest/raven/1.0/api/testrepository/${pk}/folders/${fid}/tests`;
    const res = await http.get(url, {
      params: { page, limit },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Jira/Xray auth failed (${res.status}) while listing tests in folder ${folderId}`);
    }
    if (res.status < 200 || res.status >= 300) {
      const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      throw new Error(`Jira/Xray tests request failed (${res.status}) folder ${folderId}: ${body.slice(0, 400)}`);
    }

    const batch = normalizeTestsPayload(res.data);
    if (batch.length === 0) break;

    for (const t of batch) {
      const key = t.key || t.issueKey || t.jiraKey;
      if (!key) continue;
      const dedupe = `${folderId}:${key}`;
      if (seenKeys.has(dedupe)) continue;
      seenKeys.add(dedupe);
      all.push({
        jiraKey: String(key),
        summary: t.summary || t.fields?.summary || '',
        testType: t.testType || t.type || t.fields?.customfield || t.kind,
        status: t.workflowStatus || t.status || t.fields?.status?.name,
        labels: t.labels,
        assignee: t.assignee?.displayName || t.assignee?.name || t.assignee?.emailAddress,
        rank: t.rank,
      });
    }

    if (batch.length < limit) break;
    page += 1;
  }

  return all;
}

module.exports = {
  fetchFolderTree,
  fetchAllTestsInFolder,
  normalizeBaseUrl,
};
