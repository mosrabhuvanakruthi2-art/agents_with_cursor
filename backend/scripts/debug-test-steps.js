/**
 * Debug script: print raw Xray Cloud GraphQL response for a test's steps.
 * Calls the API directly (no normalization) so you can see exactly what Xray returns.
 *
 * Usage:
 *   node scripts/debug-test-steps.js --id 53169
 *   node scripts/debug-test-steps.js TEST-40368   (requires JIRA_BASE_URL + JIRA_API_TOKEN)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const axios = require('axios');
const env = require('../src/config/env');

async function getXrayToken() {
  const clientId = env.XRAY_CLIENT_ID;
  const clientSecret = env.XRAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('XRAY_CLIENT_ID and XRAY_CLIENT_SECRET must be set in .env');
  const base = (env.XRAY_CLOUD_BASE_URL || 'https://xray.cloud.getxray.app').replace(/\/+$/, '');
  const res = await axios.post(
    `${base}/api/v2/authenticate`,
    { client_id: clientId, client_secret: clientSecret },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return res.data;
}

async function rawGraphQL(query, variables, token) {
  const base = (env.XRAY_CLOUD_BASE_URL || 'https://xray.cloud.getxray.app').replace(/\/+$/, '');
  const res = await axios.post(
    `${base}/api/v2/graphql`,
    { query, variables },
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 60000,
      validateStatus: () => true,
    }
  );
  return res.data;
}

async function resolveIssueId(issueKey) {
  const base = (env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const user = env.JIRA_USER;
  const token = env.JIRA_API_TOKEN;
  if (!base || !user || !token) return null;
  const auth = Buffer.from(`${user}:${token}`).toString('base64');
  const res = await axios.get(`${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    timeout: 30000,
    validateStatus: () => true,
  });
  return res.status === 200 ? String(res.data?.id ?? '') : null;
}

async function main() {
  const args = process.argv.slice(2);
  let issueId = null;

  const idFlagIdx = args.indexOf('--id');
  if (idFlagIdx !== -1) {
    issueId = args[idFlagIdx + 1];
  } else if (args[0]) {
    const key = args[0].trim().toUpperCase();
    console.log(`Resolving issueId for ${key} via Jira REST...`);
    issueId = await resolveIssueId(key);
    if (!issueId) {
      console.error('Could not resolve issueId. Use --id <numeric_id> instead.');
      process.exit(1);
    }
    console.log(`  → issueId: ${issueId}\n`);
  }

  if (!issueId) {
    console.error('Usage: node scripts/debug-test-steps.js --id 53169');
    process.exit(1);
  }

  console.log('Authenticating with Xray Cloud...');
  const token = await getXrayToken();
  console.log('  OK\n');

  // Full query including customFields
  const query = `
    query GetExpandedTest($issueId: String!) {
      getExpandedTest(issueId: $issueId) {
        issueId
        testType { name kind }
        steps {
          id
          action
          data
          result
          attachments { id filename }
          customFields {
            id
            value
          }
        }
      }
    }`;

  console.log(`Querying Xray for issueId: ${issueId} ...\n`);
  const raw = await rawGraphQL(query, { issueId: String(issueId) }, token);

  if (raw.errors) {
    console.log('=== GRAPHQL ERRORS ===');
    console.log(JSON.stringify(raw.errors, null, 2));

    // Retry without customFields
    console.log('\nRetrying without customFields...');
    const query2 = `
      query GetExpandedTest($issueId: String!) {
        getExpandedTest(issueId: $issueId) {
          issueId
          testType { name kind }
          steps {
            id
            action
            data
            result
          }
        }
      }`;
    const raw2 = await rawGraphQL(query2, { issueId: String(issueId) }, token);
    console.log('\n=== RAW RESPONSE (no customFields) ===');
    console.log(JSON.stringify(raw2, null, 2));
    return;
  }

  const test = raw?.data?.getExpandedTest;
  if (!test) {
    console.log('No test returned. Raw response:');
    console.log(JSON.stringify(raw, null, 2));
    return;
  }

  console.log(`=== BASIC INFO ===`);
  console.log(`  issueId  : ${test.issueId}`);
  console.log(`  testType : ${JSON.stringify(test.testType)}`);
  console.log(`  steps    : ${test.steps?.length ?? 0}`);
  console.log('');

  for (let i = 0; i < (test.steps || []).length; i++) {
    const s = test.steps[i];
    console.log(`=== STEP ${i + 1} (id: ${s.id}) ===`);

    // Print action raw shape
    const actionType = s.action == null ? 'null' : typeof s.action === 'object' ? `object(type=${s.action?.type})` : typeof s.action;
    console.log(`  action RAW type : ${actionType}`);
    console.log(`  action          : ${typeof s.action === 'string' ? s.action : JSON.stringify(s.action)}`);

    // Print data raw shape
    const dataType = s.data == null ? 'null' : typeof s.data === 'object' ? `object(type=${s.data?.type})` : typeof s.data;
    console.log(`  data RAW type   : ${dataType}`);
    if (typeof s.data === 'object' && s.data !== null) {
      console.log(`  data (raw JSON) : ${JSON.stringify(s.data)}`);
    } else {
      console.log(`  data            : ${s.data}`);
    }

    // Print result
    const resultType = s.result == null ? 'null' : typeof s.result === 'object' ? `object(type=${s.result?.type})` : typeof s.result;
    console.log(`  result RAW type : ${resultType}`);
    console.log(`  result          : ${typeof s.result === 'string' ? s.result : JSON.stringify(s.result)}`);

    // Print customFields
    if (s.customFields && s.customFields.length > 0) {
      console.log(`  customFields (${s.customFields.length}):`);
      for (const cf of s.customFields) {
        const valType = cf.value == null ? 'null' : typeof cf.value === 'object' ? `object(type=${cf.value?.type})` : typeof cf.value;
        console.log(`    id="${cf.id}"  valueType=${valType}`);
        console.log(`    value: ${JSON.stringify(cf.value)}`);
      }
    } else {
      console.log(`  customFields    : (empty — no custom step fields for this test type)`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
