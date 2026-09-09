'use strict';

/**
 * dwdEntryFrom — the merge rule used when marking a Google account as Domain-Wide Delegation.
 *
 * Why this file exists: this function used to replace the whole entry with `{ isDwd, connectedAt }`,
 * silently discarding an existing `refreshToken`. Clicking "Connect Google" on an account that
 * already had a working OAuth token therefore destroyed it, and because driveClient.getAuth() returns
 * the service-account JWT immediately when no refreshToken is stored, the OAuth fallback could no
 * longer run — every Drive call failed with `unauthorized_client` and nothing pointed at the cause.
 *
 * The two credentials are independent. Registering DWD says nothing about the OAuth token, so both
 * must survive.
 */

const assert = require('assert');
const { dwdEntryFrom } = require('../src/clients/oauthTokenStore');

const NOW = '2026-08-24T12:00:00.000Z';

// ── The regression: an existing refresh token must survive ─────────────────────
{
  const prev = {
    refreshToken: 'rt-abc',
    agent: 'content',
    connectedAt: '2026-08-01T10:00:00.000Z',
  };
  const entry = dwdEntryFrom(prev, NOW);
  assert.strictEqual(entry.refreshToken, 'rt-abc', 'refreshToken must be preserved');
  assert.strictEqual(entry.agent, 'content', 'agent must be preserved alongside the token');
  assert.strictEqual(entry.isDwd, true, 'isDwd must be set');
  assert.strictEqual(entry.connectedAt, '2026-08-01T10:00:00.000Z', 'original connectedAt is kept');
}

// ── A fresh DWD-only account ──────────────────────────────────────────────────
{
  const entry = dwdEntryFrom(undefined, NOW);
  assert.strictEqual(entry.isDwd, true);
  assert.strictEqual(entry.connectedAt, NOW, 'a new entry is stamped with now');
  assert.ok(!('refreshToken' in entry), 'no refreshToken invented when there was none');
  assert.ok(!('agent' in entry), 'no agent invented when there was none');
}

// ── An empty previous entry behaves like no entry ──────────────────────────────
{
  const entry = dwdEntryFrom({}, NOW);
  assert.strictEqual(entry.isDwd, true);
  assert.strictEqual(entry.connectedAt, NOW);
  assert.ok(!('refreshToken' in entry));
}

// ── Re-registering an already-DWD account is idempotent ───────────────────────
{
  const prev = { isDwd: true, connectedAt: '2026-06-25T13:53:10.742Z' };
  const entry = dwdEntryFrom(prev, NOW);
  assert.deepStrictEqual(entry, { isDwd: true, connectedAt: '2026-06-25T13:53:10.742Z' });
}

// ── A token with no agent recorded still keeps the token ──────────────────────
{
  const entry = dwdEntryFrom({ refreshToken: 'rt-xyz' }, NOW);
  assert.strictEqual(entry.refreshToken, 'rt-xyz');
  assert.ok(!('agent' in entry), 'agent is only carried when it was present');
  assert.strictEqual(entry.connectedAt, NOW);
}

// ── Calling it twice must not lose the token on the second pass ───────────────
{
  const once = dwdEntryFrom({ refreshToken: 'rt-1', agent: 'content', connectedAt: NOW }, NOW);
  const twice = dwdEntryFrom(once, NOW);
  assert.strictEqual(twice.refreshToken, 'rt-1', 'token survives repeated registration');
  assert.strictEqual(twice.agent, 'content');
  assert.strictEqual(twice.isDwd, true);
}

console.log('dwdEntry.test.js: ok');
