const path = require('path');
const fs = require('fs');
const axios = require('axios');
const logger = require('../utils/logger');

const CUSTOM_CASES_FILE = path.resolve(__dirname, '../../data/custom-test-cases.json');

function readCustomCases() {
  try {
    if (!fs.existsSync(CUSTOM_CASES_FILE)) return { smoke: [], sanity: [] };
    return JSON.parse(fs.readFileSync(CUSTOM_CASES_FILE, 'utf8'));
  } catch {
    return { smoke: [], sanity: [] };
  }
}

function writeCustomCases(data) {
  fs.writeFileSync(CUSTOM_CASES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const MAIL_CONTEXT = {
  'Gmail → Outlook': {
    how: `1. Test emails are inserted into Gmail source account via Gmail API
2. A CloudFuze migration job copies them to the Outlook destination
3. The destination Outlook account is validated for correct folder mapping`,
    mapping: `GMAIL LABEL → OUTLOOK FOLDER MAPPING:
- INBOX → Inbox
- SENT → Sent Items
- SPAM → Junk Email
- TRASH → Deleted Items
- INBOX + STARRED → Inbox (flagged)
- INBOX + IMPORTANT → Inbox (high importance)
- INBOX + CATEGORY_SOCIAL/FORUMS/PROMOTIONS/UPDATES → inbox category tabs`,
    stepVerbs: ['Log in to Gmail source account', 'Trigger CloudFuze migration', 'Log in to destination Outlook account', 'Navigate to the expected folder'],
  },
  'Gmail → Gmail': {
    how: `1. Test emails are inserted into Gmail source account via Gmail API
2. A CloudFuze migration job copies them to the Gmail destination account
3. The destination Gmail account is validated for correct label mapping`,
    mapping: `GMAIL LABEL → GMAIL LABEL MAPPING:
- INBOX → Inbox
- SENT → Sent
- SPAM → Spam
- TRASH → Trash
- STARRED → Starred
- Custom labels → same label names in destination`,
    stepVerbs: ['Log in to Gmail source account', 'Trigger CloudFuze migration', 'Log in to destination Gmail account', 'Navigate to the expected label/folder'],
  },
  'Outlook → Outlook': {
    how: `1. Test emails exist in the Outlook source account
2. A CloudFuze migration job copies them to the destination Outlook account
3. The destination Outlook account is validated for correct folder mapping`,
    mapping: `OUTLOOK FOLDER → OUTLOOK FOLDER MAPPING:
- Inbox → Inbox
- Sent Items → Sent Items
- Junk Email → Junk Email
- Deleted Items → Deleted Items
- Drafts → Drafts
- Custom folders → same folder names in destination`,
    stepVerbs: ['Log in to Outlook source account', 'Trigger CloudFuze migration', 'Log in to destination Outlook account', 'Navigate to the expected folder'],
  },
  'Outlook → Gmail': {
    how: `1. Test emails exist in the Outlook source account
2. A CloudFuze migration job copies them to the Gmail destination account
3. The destination Gmail account is validated for correct label mapping`,
    mapping: `OUTLOOK FOLDER → GMAIL LABEL MAPPING:
- Inbox → INBOX
- Sent Items → SENT
- Junk Email → SPAM
- Deleted Items → TRASH
- Custom folders → Custom Gmail labels`,
    stepVerbs: ['Log in to Outlook source account', 'Trigger CloudFuze migration', 'Log in to destination Gmail account', 'Navigate to the expected label'],
  },
};

const MESSAGE_CONTEXT = {
  default: {
    how: `1. Messages/channels exist in the source messaging platform
2. A CloudFuze migration job copies them to the destination platform
3. The destination is validated for correct channel/conversation mapping`,
    mapping: `MESSAGE MIGRATION MAPPING:
- Channels → equivalent channels/spaces in destination
- Direct Messages → direct messages or equivalent
- Threads → threaded replies in destination
- Attachments → file attachments migrated with messages
- Reactions/Emojis → mapped to closest equivalent`,
    stepVerbs: ['Log in to source messaging platform', 'Trigger CloudFuze migration', 'Log in to destination platform', 'Navigate to the expected channel/conversation'],
  },
};

function buildSystemPrompt(productType, combination, folder) {
  const isMessage = productType === 'Message';
  const ctx = isMessage
    ? MESSAGE_CONTEXT.default
    : (MAIL_CONTEXT[combination] || MAIL_CONTEXT['Gmail → Outlook']);

  const folderInstruction = folder
    ? `FOLDER OVERRIDE: Every test case MUST use folder = "${folder}". Do not auto-detect or change this.`
    : isMessage
      ? `folder: AUTO-DETECT. Choose from: 'Channels', 'Direct Messages', 'Group Messages', 'Threads', 'Attachments', 'Reactions', 'Pinned Messages', 'Archived Channels', 'Negative Test Cases'.`
      : `folder: AUTO-DETECT from scenario context. Choose from: 'Inbox', 'Sent', 'Draft', 'Spam', 'Trash', 'Labels', 'Starred', 'Attachments', 'Calendar Events', 'Contacts', 'Groups', 'Negative Test Cases', 'Delta Inbox', 'Delta Sent', 'Delta Draft', 'Delta Spam', 'Delta Trash', 'Cloud Adding'. NEVER use 'Sanity Cases' or 'Smoke Cases'.`;

  const subjectNote = isMessage
    ? `subject: A short identifier starting with "QA Custom - " — describe the message type being tested`
    : `subject: Email subject starting with "QA Custom - " followed by a descriptive name`;

  const labelNote = isMessage
    ? `labelIds: Leave as ["INBOX"] — not applicable for messaging migration`
    : `labelIds: one or more Gmail label IDs from: INBOX, SENT, SPAM, TRASH, STARRED, IMPORTANT, CATEGORY_SOCIAL, CATEGORY_FORUMS, CATEGORY_PROMOTIONS, CATEGORY_UPDATES`;

  return `You are a QA test case generator for CloudFuze ${productType} migration (${combination}).

HOW THE SYSTEM WORKS:
${ctx.how}

${ctx.mapping}

YOU MUST return a JSON object with a "testCases" key. Every single field below is REQUIRED and must be filled with meaningful, scenario-specific content — never leave any field empty or null.

Each test case object MUST have ALL of these fields:
{
  "summary": "One-line title describing what is being validated",
  "action": "The specific migration action being tested — name both source and destination platforms explicitly",
  "testData": "Concrete description of the test data — be specific about content type, format, and metadata",
  "testSteps": [
    "${ctx.stepVerbs[0]} and confirm test data exists",
    "Trigger CloudFuze migration job for the source account",
    "Wait for migration job to complete successfully",
    "${ctx.stepVerbs[2]}",
    "Navigate to the expected location and verify the data is present with all fields intact"
  ],
  "expectedResult": "Specific expected outcome — describe exactly what should match between source and destination",
  "combination": "${combination}",
  "productType": "${productType}",
  "${folderInstruction}",
  ${subjectNote},
  "textBody": "The plain-text body or content description — make it scenario-relevant",
  "${labelNote}",
  "hasAttachment": false
}

RULES:
- Every field must have a real, meaningful value — no empty strings, no null, no "N/A"
- testSteps must have 4–5 concrete steps specific to ${combination} migration
- Each test case must validate a DISTINCT aspect of the scenario
- subject must always start with "QA Custom - "
- combination MUST always be exactly "${combination}"
- productType MUST always be exactly "${productType}"`;
}

function buildUserPrompt(scenarios, count, productType, combination, folder) {
  const scenarioText = Array.isArray(scenarios)
    ? scenarios.map((s, i) => `Scenario ${i + 1}: ${s.trim()}`).join('\n')
    : `Scenario: ${scenarios.trim()}`;

  const ctx = folder ? ` All test cases must use folder="${folder}".` : '';
  return `Generate exactly ${count} test case(s) for ${productType} migration (${combination}).${ctx} Each must be fully populated with all required fields.\n\n${scenarioText}`;
}

async function generateTestCases(req, res) {
  const { scenario, scenarios, count, productType, combination, folder } = req.body || {};

  const scenarioList = scenarios && Array.isArray(scenarios) && scenarios.length > 0
    ? scenarios.filter((s) => s && s.trim())
    : scenario && scenario.trim()
      ? [scenario.trim()]
      : [];

  if (scenarioList.length === 0) {
    return res.status(400).json({ error: 'At least one scenario is required' });
  }

  const requestedCount   = Math.min(Math.max(parseInt(count, 10) || 5, 1), 20);
  const effectiveProduct = (productType || 'Mail').trim();
  const effectiveCombo   = (combination || 'Gmail → Outlook').trim();
  const effectiveFolder  = (folder || '').trim();

  const apiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({
      error: 'OPENAI_API_KEY is not set. Add it to backend/.env to use the test case generator.',
    });
  }

  try {
    const systemPrompt = buildSystemPrompt(effectiveProduct, effectiveCombo, effectiveFolder);
    const userPrompt   = buildUserPrompt(scenarioList, requestedCount, effectiveProduct, effectiveCombo, effectiveFolder);

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 6000,
        temperature: 0.5,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 90000,
      }
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content) return res.status(500).json({ error: 'No response from AI model' });

    let testCases;
    try {
      const parsed = JSON.parse(content);
      testCases = parsed.testCases || parsed;
      if (!Array.isArray(testCases)) throw new Error('not an array');
    } catch (e) {
      logger.error(`generateTestCases: JSON parse failed — ${e.message}`);
      return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' });
    }

    // Always enforce the user-selected product/combination/folder regardless of what AI returned
    testCases = testCases.map((tc) => ({
      ...tc,
      productType: effectiveProduct,
      combination: effectiveCombo,
      ...(effectiveFolder ? { folder: effectiveFolder } : {}),
    }));

    res.json({ testCases });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message || 'Failed to generate test cases';
    logger.error(`generateTestCases error: ${msg}`);
    res.status(500).json({ error: msg });
  }
}

/* Returns true if an identical test case already exists in the given list.
   Matches on normalised subject (primary) OR normalised summary (fallback). */
function isDuplicate(existing, testCase) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const subj = norm(testCase.subject);
  const summ = norm(testCase.summary || testCase.subject);
  return existing.some(
    (tc) => norm(tc.subject) === subj || norm(tc.summary || tc.subject) === summ
  );
}

function getCustomTestCases(req, res) {
  res.json(readCustomCases());
}

function addCustomTestCase(req, res) {
  const { testType, testCase } = req.body || {};

  if (!testType || !['smoke', 'sanity'].includes(testType)) {
    return res.status(400).json({ error: 'testType must be "smoke" or "sanity"' });
  }
  if (!testCase || !testCase.subject) {
    return res.status(400).json({ error: 'testCase with subject is required' });
  }

  const data = readCustomCases();

  if (isDuplicate(data[testType], testCase)) {
    return res.status(409).json({
      error: 'duplicate',
      message: `"${testCase.summary || testCase.subject}" already exists in ${testType} test cases.`,
    });
  }

  const nextNum = data[testType].length + 1;
  const idPrefix = testType === 'smoke' ? 'Testsmoke' : 'Testsanity';
  const testCaseId = `${idPrefix}${nextNum}`;

  const entry = {
    id: testCaseId,
    testCaseId,
    testType,
    addedAt: new Date().toISOString(),
    summary: testCase.summary || testCase.subject,
    action: testCase.action || '',
    testData: testCase.testData || '',
    testSteps: Array.isArray(testCase.testSteps) ? testCase.testSteps : [],
    expectedResult: testCase.expectedResult || '',
    combination: testCase.combination || '',
    productType: testCase.productType || 'Mail',
    folder: testCase.folder || (testType === 'smoke' ? '/Smoke Cases' : '/Sanity Cases'),
    subject: testCase.subject,
    textBody: testCase.textBody || '',
    htmlBody: testCase.htmlBody || undefined,
    labelIds: testCase.labelIds || ['INBOX'],
    hasAttachment: !!testCase.hasAttachment,
  };
  if (!entry.htmlBody) delete entry.htmlBody;

  data[testType].push(entry);
  writeCustomCases(data);
  res.json({ success: true, entry });
}

// Add multiple test cases at once (used by Select All)
function addBulkTestCases(req, res) {
  const { testType, testCases } = req.body || {};

  if (!testType || !['smoke', 'sanity'].includes(testType)) {
    return res.status(400).json({ error: 'testType must be "smoke" or "sanity"' });
  }
  if (!Array.isArray(testCases) || testCases.length === 0) {
    return res.status(400).json({ error: 'testCases array is required' });
  }

  const data = readCustomCases();
  const idPrefix = testType === 'smoke' ? 'Testsmoke' : 'Testsanity';
  const added = [];
  const skipped = [];

  for (const testCase of testCases) {
    if (!testCase || !testCase.subject) continue;
    if (isDuplicate(data[testType], testCase)) {
      skipped.push(testCase.summary || testCase.subject);
      continue;
    }
    const nextNum = data[testType].length + 1;
    const testCaseId = `${idPrefix}${nextNum}`;
    const entry = {
      id: testCaseId,
      testCaseId,
      testType,
      addedAt: new Date().toISOString(),
      summary: testCase.summary || testCase.subject,
      action: testCase.action || '',
      testData: testCase.testData || '',
      testSteps: Array.isArray(testCase.testSteps) ? testCase.testSteps : [],
      expectedResult: testCase.expectedResult || '',
      combination: testCase.combination || '',
      productType: testCase.productType || 'Mail',
      folder: testCase.folder || (testType === 'smoke' ? '/Smoke Cases' : '/Sanity Cases'),
      subject: testCase.subject,
      textBody: testCase.textBody || '',
      htmlBody: testCase.htmlBody || undefined,
      labelIds: testCase.labelIds || ['INBOX'],
      hasAttachment: !!testCase.hasAttachment,
    };
    if (!entry.htmlBody) delete entry.htmlBody;
    data[testType].push(entry);
    added.push(entry);
  }

  if (added.length > 0) writeCustomCases(data);
  res.json({ success: true, added: added.length, skipped: skipped.length, skippedNames: skipped, entries: added });
}

function deleteCustomTestCase(req, res) {
  const { id } = req.params;
  const { testType } = req.query;

  if (!testType || !['smoke', 'sanity'].includes(testType)) {
    return res.status(400).json({ error: 'testType query param must be "smoke" or "sanity"' });
  }

  const data = readCustomCases();
  const before = data[testType].length;
  data[testType] = data[testType].filter((tc) => tc.id !== id);

  if (data[testType].length === before) {
    return res.status(404).json({ error: 'Test case not found' });
  }

  writeCustomCases(data);
  res.json({ success: true });
}

const UPDATABLE_FIELDS = [
  'summary', 'action', 'testData', 'testSteps', 'expectedResult',
  'combination', 'productType', 'folder', 'subject', 'textBody',
  'labelIds', 'hasAttachment',
];

function updateCustomTestCase(req, res) {
  const { id } = req.params;
  const { testType, updates } = req.body || {};

  if (!testType || !['smoke', 'sanity'].includes(testType)) {
    return res.status(400).json({ error: 'testType must be "smoke" or "sanity"' });
  }
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'updates object is required' });
  }

  const data = readCustomCases();
  const idx = data[testType].findIndex((tc) => tc.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'Test case not found' });
  }

  for (const key of UPDATABLE_FIELDS) {
    if (updates[key] !== undefined) {
      data[testType][idx][key] = updates[key];
    }
  }
  data[testType][idx].updatedAt = new Date().toISOString();

  writeCustomCases(data);
  res.json({ success: true, entry: data[testType][idx] });
}

module.exports = {
  generateTestCases,
  getCustomTestCases,
  addCustomTestCase,
  addBulkTestCases,
  deleteCustomTestCase,
  updateCustomTestCase,
};
