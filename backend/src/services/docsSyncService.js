/**
 * docsSyncService.js
 *
 * Documentation sync service for the migration QA project.
 *
 * Workflow:
 *   1. Fetches ALL 8 combination×scope pairs from https://doc.cftools.live/api/features
 *   2. Compares against stored snapshot in backend/data/docs-features-snapshot.json
 *   3. Detects newly added inscope and outscope features
 *   4. NEW OUTSCOPE features → auto-appended to the FEATURES array in cloudfuzeDocsClient.js
 *   5. NEW INSCOPE features  → GPT-4o generates test case + validation suggestions
 *   6. Results stored in backend/data/docs-sync-results.json
 *   7. Snapshot updated so the next run compares against current state
 */

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const OpenAI = require('openai');
const logger = require('../utils/logger');
const { saveLastKnown } = require('../clients/cloudfuzeDocsClient');

// ── Paths ─────────────────────────────────────────────────────────────────────

const DATA_DIR      = path.resolve(__dirname, '../../data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'docs-features-snapshot.json');
const RESULTS_FILE  = path.join(DATA_DIR, 'docs-sync-results.json');
const DOCS_CLIENT   = path.resolve(__dirname, '../clients/cloudfuzeDocsClient.js');
const DOCS_BASE     = 'https://doc.cftools.live';

// ── Combinations to check ─────────────────────────────────────────────────────

const COMBINATIONS = [
  { combination: 'Outlook to Gmail',   sourceProvider: 'microsoft', destProvider: 'google'    },
  { combination: 'Gmail to Outlook',   sourceProvider: 'google',    destProvider: 'microsoft' },
  { combination: 'Outlook to Outlook', sourceProvider: 'microsoft', destProvider: 'microsoft' },
  { combination: 'Gmail to Gmail',     sourceProvider: 'google',    destProvider: 'google'    },
];
const SCOPES = ['inscope', 'outscope'];

// ── OpenAI helper ─────────────────────────────────────────────────────────────

let _openaiClient = null;
function getOpenAIClient() {
  if (!_openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable not set');
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

/**
 * Ask GPT-4o to generate a test case scaffold for a newly discovered inscope feature.
 *
 * @param {string} featureName   Feature name from the docs API
 * @param {string} description   Feature description
 * @param {string} combination   e.g. "Outlook to Gmail"
 * @param {string} sourceProvider  e.g. "microsoft"
 * @returns {Promise<object>}    Generated test case object
 */
async function generateTestCaseForInscopeFeature(featureName, description, combination, sourceProvider) {
  const agentFile = sourceProvider === 'microsoft'
    ? 'OutlookTestDataAgent.js'
    : 'GmailTestDataAgent.js';

  const prompt = `A new inscope feature '${featureName}' has been added to the ${combination} mail migration combination.
Description: ${description || 'No description provided.'}

Generate:
1. A test scenario name and email subject for ${agentFile}
2. A validation check description for the validation agent
3. The key data fields to seed and verify

Respond with a JSON object (no markdown fences):
{
  "subject": "QA E2E - <Feature Name> Test",
  "scenarioName": "short scenario name",
  "dataToSeed": "describe what email data should be seeded to exercise this feature",
  "validationCheck": "describe exactly what the validation agent should verify after migration",
  "keyFields": ["field1", "field2"],
  "agentFile": "${agentFile}",
  "status": "pending_implementation"
}`;

  try {
    const client = getOpenAIClient();
    const response = await client.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 600,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert email migration QA engineer. ' +
            'Generate concise, actionable test case scaffolds for migration validation agents. ' +
            'Always return valid JSON without markdown code fences.',
        },
        { role: 'user', content: prompt },
      ],
    });

    const raw = (response.choices[0]?.message?.content ?? '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    return JSON.parse(raw);
  } catch (err) {
    logger.warn(`[docsSyncService] GPT test case generation failed for "${featureName}": ${err.message}`);
    return {
      subject: `QA E2E - ${featureName} Test`,
      scenarioName: featureName,
      dataToSeed: `Seed an email that exercises the "${featureName}" feature for ${combination} migration.`,
      validationCheck: `Verify the "${featureName}" feature is preserved correctly after migration.`,
      keyFields: [],
      agentFile,
      status: 'pending_implementation',
      _generationError: err.message,
    };
  }
}

// ── Live API fetcher ──────────────────────────────────────────────────────────

/**
 * Fetch features from the live docs API for one combination+scope pair.
 * Returns an array of feature objects (shape: { name, description, ... }).
 */
async function fetchLiveFeatures(combination, scope) {
  try {
    const res = await axios.get(`${DOCS_BASE}/api/features`, {
      params: { productType: 'Mail', combination, scope },
      timeout: 15000,
    });
    return Array.isArray(res.data?.features) ? res.data.features : [];
  } catch (err) {
    logger.warn(
      `[docsSyncService] Could not fetch ${scope} features for "${combination}": ${err.message}`
    );
    return null; // null = API unreachable (distinct from empty array)
  }
}

/**
 * Fetch all 8 combination×scope pairs.
 * Returns a nested object: { [combination]: { inscope: [...], outscope: [...] } }
 * Values are null when the API was unreachable for that pair.
 */
async function fetchAllLiveFeatures() {
  const result = {};

  await Promise.all(
    COMBINATIONS.map(async ({ combination }) => {
      result[combination] = {};
      await Promise.all(
        SCOPES.map(async (scope) => {
          result[combination][scope] = await fetchLiveFeatures(combination, scope);
        })
      );
    })
  );

  return result;
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/**
 * Load the stored snapshot (or return an empty structure if none exists).
 */
function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.warn(`[docsSyncService] Could not read snapshot: ${err.message}`);
  }
  return { combinations: {}, createdAt: null };
}

/**
 * Persist a new snapshot.
 */
function saveSnapshot(snapshot) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf-8');
}

/**
 * Persist sync results.
 */
function saveResults(results) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2), 'utf-8');
}

// ── Feature diffing ───────────────────────────────────────────────────────────

/**
 * Given the live feature list and the previously snapshotted list for a
 * specific combination+scope pair, return features that are genuinely new
 * (appear in live but not in snapshot).
 *
 * Name comparison is case-insensitive.
 */
function detectNewFeatures(liveFeatures, snapshotFeatures) {
  if (!Array.isArray(liveFeatures)) return [];
  const knownNames = new Set(
    (Array.isArray(snapshotFeatures) ? snapshotFeatures : []).map((f) =>
      String(f.name || '').toLowerCase()
    )
  );
  return liveFeatures.filter((f) => !knownNames.has(String(f.name || '').toLowerCase()));
}

// ── FEATURES auto-updater ─────────────────────────────────────────────────────

/**
 * Build a JavaScript source snippet for one new outscope FEATURES entry.
 */
function buildFeaturesEntry(combination, feature) {
  const name        = String(feature.name        || '').replace(/'/g, "\\'");
  const description = String(feature.description || '').replace(/'/g, "\\'");

  // Derive match keywords from the feature name words (words longer than 3 chars)
  const words = name.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const matchKeywords = JSON.stringify([...new Set([name.toLowerCase(), ...words])]);

  return `  {
    combination: '${combination}',
    scope: 'outscope',
    name: '${name}',
    description: '${description}',
    matchFields: [],
    matchKinds: ['other'],
    matchKeywords: ${matchKeywords},
  },`;
}

/**
 * Append new outscope features to the FEATURES array in cloudfuzeDocsClient.js.
 *
 * Strategy: find the closing ]; of the FEATURES array and insert entries
 * just before it, inside the correct combination section comment block
 * (or at the end of the array if no matching comment exists).
 *
 * Returns { success, added, errors }.
 */
function autoAddOutscopeFeatures(newFeatures) {
  const summary = { success: true, added: [], errors: [] };
  if (!newFeatures || newFeatures.length === 0) return summary;

  let src;
  try {
    src = fs.readFileSync(DOCS_CLIENT, 'utf-8');
  } catch (err) {
    summary.success = false;
    summary.errors.push(`Cannot read cloudfuzeDocsClient.js: ${err.message}`);
    return summary;
  }

  // We insert each new entry just before the closing ]; of the FEATURES array.
  // The marker we look for is the exact line that ends the array:
  //   ];
  // preceded by a blank line or a comment line inside the FEATURES block.
  // We locate it by finding the last occurrence of the pattern:
  //   ^];
  // within the FEATURES = [ ... ]; block.

  for (const { combination, feature } of newFeatures) {
    // Skip if it somehow already exists
    const alreadyIn = src.toLowerCase().includes(
      `name: '${String(feature.name || '').toLowerCase()}'`
    );
    if (alreadyIn) {
      summary.errors.push(`"${feature.name}" already present in FEATURES — skipped`);
      continue;
    }

    const entry = buildFeaturesEntry(combination, feature);

    // Find the closing ]; of the FEATURES array
    const closingMarker = '\n];\n';
    const closingIdx    = src.lastIndexOf(closingMarker);
    if (closingIdx === -1) {
      summary.errors.push(`Cannot locate FEATURES array closing in cloudfuzeDocsClient.js for "${feature.name}"`);
      summary.success = false;
      continue;
    }

    src =
      src.slice(0, closingIdx) +
      '\n' + entry +
      src.slice(closingIdx);

    summary.added.push(feature.name);
    logger.info(`[docsSyncService] Auto-added outscope feature to FEATURES: "${feature.name}" (${combination})`);
  }

  if (summary.added.length > 0) {
    try {
      fs.writeFileSync(DOCS_CLIENT, src, 'utf-8');
    } catch (err) {
      summary.success = false;
      summary.errors.push(`Failed to write cloudfuzeDocsClient.js: ${err.message}`);
    }
  }

  return summary;
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Run the full documentation sync.
 *
 * @returns {Promise<object>}  Sync results object
 */
async function runSync() {
  logger.info('[docsSyncService] Starting docs sync…');

  // 1. Fetch current live state
  const liveData = await fetchAllLiveFeatures();

  // 2. Load previous snapshot
  const snapshot = loadSnapshot();

  // 3. Diff each combination×scope pair
  const newInscopeFeatures  = [];
  const newOutscopeFeatures = [];
  let   anyApiUnreachable   = false;

  for (const { combination, sourceProvider } of COMBINATIONS) {
    for (const scope of SCOPES) {
      const liveFeatures     = liveData[combination]?.[scope];
      const snapshotFeatures = snapshot.combinations?.[combination]?.[scope] ?? [];

      if (liveFeatures === null) {
        // API unreachable for this pair — skip diff but note it
        anyApiUnreachable = true;
        logger.warn(`[docsSyncService] API unreachable for ${combination}/${scope} — skipping diff`);
        continue;
      }

      const newOnes = detectNewFeatures(liveFeatures, snapshotFeatures);

      for (const feature of newOnes) {
        if (scope === 'inscope') {
          newInscopeFeatures.push({ combination, sourceProvider, feature });
        } else {
          newOutscopeFeatures.push({ combination, feature });
        }
      }
    }
  }

  logger.info(
    `[docsSyncService] Detected ${newInscopeFeatures.length} new inscope, ` +
    `${newOutscopeFeatures.length} new outscope features`
  );

  // 4. Auto-add new outscope features to cloudfuzeDocsClient.js
  let autoAddSummary = { success: true, added: [], errors: [] };
  if (newOutscopeFeatures.length > 0) {
    autoAddSummary = autoAddOutscopeFeatures(newOutscopeFeatures);
  }

  // 5. Generate GPT test cases for new inscope features
  const inscopeResults = [];
  for (const { combination, sourceProvider, feature } of newInscopeFeatures) {
    let generatedTestCase = null;
    try {
      generatedTestCase = await generateTestCaseForInscopeFeature(
        feature.name,
        feature.description,
        combination,
        sourceProvider
      );
    } catch (err) {
      logger.warn(`[docsSyncService] Test case generation error for "${feature.name}": ${err.message}`);
      generatedTestCase = {
        subject: `QA E2E - ${feature.name} Test`,
        dataToSeed: '',
        validationCheck: '',
        agentFile: sourceProvider === 'microsoft' ? 'OutlookTestDataAgent.js' : 'GmailTestDataAgent.js',
        status: 'pending_implementation',
        _generationError: err.message,
      };
    }

    inscopeResults.push({
      combination,
      feature: feature.name,
      description: feature.description || '',
      generatedTestCase,
    });
  }

  // 6. Build outscope results
  const outscopeResults = newOutscopeFeatures.map(({ combination, feature }) => {
    const words = String(feature.name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return {
      combination,
      feature: feature.name,
      description: feature.description || '',
      autoAdded: autoAddSummary.added.includes(feature.name),
      autoAddError: autoAddSummary.errors.find((e) => e.includes(feature.name)) || null,
      matchKeywords: [...new Set([String(feature.name || '').toLowerCase(), ...words])],
    };
  });

  // 7. Build final results object
  const results = {
    lastSyncAt: new Date().toISOString(),
    newInscopeFeatures: inscopeResults,
    newOutscopeFeatures: outscopeResults,
    noChanges: inscopeResults.length === 0 && outscopeResults.length === 0,
    apiPartiallyUnreachable: anyApiUnreachable,
    autoAddSummary,
  };

  // 8. Save results
  saveResults(results);

  // 9. Update snapshot — only update pairs where the API responded
  const newSnapshot = {
    createdAt: new Date().toISOString(),
    combinations: JSON.parse(JSON.stringify(snapshot.combinations || {})),
  };

  for (const { combination } of COMBINATIONS) {
    if (!newSnapshot.combinations[combination]) {
      newSnapshot.combinations[combination] = {};
    }
    for (const scope of SCOPES) {
      const liveFeatures = liveData[combination]?.[scope];
      if (liveFeatures !== null) {
        // Overwrite only when we got a real response
        newSnapshot.combinations[combination][scope] = liveFeatures;
      }
      // If null (unreachable), keep the previous snapshot value intact
    }
  }

  saveSnapshot(newSnapshot);

  // ── Overwrite last-known file with ONLY the latest sync data ─────────────
  // Flatten liveData into { "Outlook to Gmail::inscope": [...], ... } format.
  // Any previous data is discarded — only the most recent sync is kept.
  const lastKnownMap = {};
  for (const { combination } of COMBINATIONS) {
    for (const scope of SCOPES) {
      const features = liveData[combination]?.[scope];
      if (features !== null && Array.isArray(features)) {
        lastKnownMap[`${combination}::${scope}`] = features;
      }
    }
  }
  if (Object.keys(lastKnownMap).length > 0) {
    saveLastKnown(lastKnownMap);
  }

  logger.info(
    `[docsSyncService] Sync complete — ` +
    `${inscopeResults.length} inscope, ${outscopeResults.length} outscope changes. ` +
    `Auto-added ${autoAddSummary.added.length} outscope entries.`
  );

  return results;
}

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Load the last sync results from disk (or return null if none exist).
 */
function getLastResults() {
  try {
    if (fs.existsSync(RESULTS_FILE)) {
      return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.warn(`[docsSyncService] Could not read results file: ${err.message}`);
  }
  return null;
}

/**
 * Load the current feature snapshot from disk.
 */
function getSnapshot() {
  return loadSnapshot();
}

module.exports = { runSync, getLastResults, getSnapshot };
