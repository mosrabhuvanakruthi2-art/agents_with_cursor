/**
 * Run: node test/hotjar.test.js (from frontend/)
 *
 * Plain Node + assert, matching backend/test/*. The frontend has no DOM test runner, so this stubs
 * the handful of DOM calls hotjar.js makes rather than pulling in jsdom.
 */
import assert from 'node:assert';

// ─── Minimal DOM stub ────────────────────────────────────────────────────────
let appended = [];

function resetDom() {
  appended = [];
  globalThis.window = {};
  globalThis.document = {
    getElementById: (id) => appended.find((n) => n.id === id) || null,
    createElement: () => ({ id: '', async: false, src: '' }),
    head: { appendChild: (node) => appended.push(node) },
  };
}

function withSiteId(id) {
  resetDom();
  globalThis.window.__APP_CONFIG__ = { hotjarSiteId: id };
}

function captureWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

resetDom();
const { initHotjar, isHotjarEnabled, identifyHotjarUser } = await import('../src/analytics/hotjar.js');

function run() {
  // ── Blank site ID is the "off" state: nothing requested, nothing recorded ──
  withSiteId('');
  assert.strictEqual(isHotjarEnabled(), false);
  assert.strictEqual(initHotjar(), false);
  assert.strictEqual(document.getElementById('hotjar-snippet'), null);
  assert.strictEqual(appended.length, 0);

  // An entrypoint placeholder that was never substituted must fall through, not be used.
  withSiteId('__HOTJAR_SITE_ID__');
  assert.strictEqual(isHotjarEnabled(), false);
  assert.strictEqual(initHotjar(), false);
  assert.strictEqual(appended.length, 0);

  // ── Valid ID injects exactly once, with a numeric hjid ──
  withSiteId('6766428');
  assert.strictEqual(isHotjarEnabled(), true);
  assert.strictEqual(initHotjar(), true);
  assert.strictEqual(window._hjSettings.hjid, 6766428);
  assert.strictEqual(typeof window._hjSettings.hjid, 'number');
  assert.strictEqual(window._hjSettings.hjsv, 6);
  assert.strictEqual(appended.length, 1);
  assert.strictEqual(appended[0].id, 'hotjar-snippet');
  assert.strictEqual(appended[0].src, 'https://static.hotjar.com/c/hotjar-6766428.js?sv=6');
  // Idempotent — StrictMode double-invokes effects and two snippets would double-record.
  assert.strictEqual(initHotjar(), false);
  assert.strictEqual(appended.length, 1);

  // Surrounding whitespace is tolerated rather than tripping the digits-only guard.
  withSiteId('  6766428  ');
  assert.strictEqual(initHotjar(), true);
  assert.strictEqual(window._hjSettings.hjid, 6766428);

  // ── A typo'd ID must be loud, not silently indistinguishable from "disabled" ──
  withSiteId('site-6766428');
  const warnings = captureWarnings(() => {
    assert.strictEqual(initHotjar(), false);
  });
  assert.strictEqual(appended.length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes('digits only'), 'warning should explain the expected format');

  // ── identify: queued before the remote script lands, and case-normalised ──
  withSiteId('6766428');
  assert.strictEqual(initHotjar(), true);
  assert.strictEqual(identifyHotjarUser({ email: 'Jane.Doe@cloudfuze.com', name: 'Jane Doe' }), true);
  const call = window.hj.q[0];
  assert.strictEqual(call[0], 'identify');
  assert.strictEqual(call[1], 'jane.doe@cloudfuze.com');
  assert.strictEqual(call[2].name, 'Jane Doe');
  assert.strictEqual(call[2].role, 'UNKNOWN');

  // No email, or Hotjar off, means no identify call at all.
  assert.strictEqual(identifyHotjarUser({}), false);
  assert.strictEqual(identifyHotjarUser(null), false);
  withSiteId('');
  assert.strictEqual(identifyHotjarUser({ email: 'a@b.com' }), false);

  console.log('hotjar.test.js: all assertions passed');
}

run();
