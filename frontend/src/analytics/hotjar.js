import { resolveHotjarSiteId } from '../config/runtimeConfig.js';

const SCRIPT_ID = 'hotjar-snippet';

// Snippet version Hotjar expects in both _hjSettings and the script URL. Bumping this is Hotjar's
// call, not ours -- it changes only when they ship a new loader contract.
const SNIPPET_VERSION = 6;

export function isHotjarEnabled() {
  return Boolean(resolveHotjarSiteId());
}

/**
 * Injects the Hotjar snippet. No-ops when no site ID is configured, which is the normal state in
 * local development and on any deploy that has not opted in.
 *
 * Idempotent on purpose: React.StrictMode double-invokes effects in development, and two copies of
 * the snippet would open two recordings for one page view.
 *
 * @returns {boolean} true only when this call actually injected the script.
 */
export function initHotjar() {
  const siteId = resolveHotjarSiteId();
  if (!siteId) return false;
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (document.getElementById(SCRIPT_ID)) return false;

  // A non-numeric ID would silently request hotjar-NaN.js and fail with nothing in the console
  // pointing at the cause. Say so instead -- a typo'd ID and a deliberately disabled Hotjar should
  // not look identical to whoever is debugging.
  if (!/^\d+$/.test(siteId)) {
    console.warn(
      `[analytics] Ignoring hotjarSiteId="${siteId}": a Hotjar Site ID is digits only ` +
        `(e.g. "6766428"). Find it under Settings -> Sites & Organizations in Hotjar. Recording is off.`
    );
    return false;
  }

  // The queue has to exist before the remote script loads, so calls made during the first render --
  // identify, in particular -- are replayed instead of dropped on the floor.
  window.hj =
    window.hj ||
    function () {
      (window.hj.q = window.hj.q || []).push(arguments);
    };
  // Number, not string: Hotjar's own snippet emits `hjid:6766428` as a numeric literal and the
  // remote script reads this value back. The digits-only guard above means Number() cannot NaN here.
  window._hjSettings = { hjid: Number(siteId), hjsv: SNIPPET_VERSION };

  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = `https://static.hotjar.com/c/hotjar-${siteId}.js?sv=${SNIPPET_VERSION}`;
  document.head.appendChild(script);
  return true;
}

/**
 * Tags the current recording with the signed-in operator, so recordings can be filtered per person.
 *
 * Pass ONLY the operator -- the CloudFuze employee driving the tool, from getAppUser(). Never pass a
 * migration source or destination mailbox: those are third-party customer accounts under test, and
 * identifying a session by one would ship customer PII to Hotjar and attribute the session to the
 * wrong party.
 *
 * Email is a safe identifier here because every operator arrives through single-tenant Azure AD. An
 * app open to customer or public sign-up would need an opaque user ID instead.
 *
 * Note: filtering by these attributes is a paid Hotjar feature. On a tier without it the call is
 * accepted and ignored, so this stays safe to ship regardless of plan.
 *
 * @returns {boolean} true only when an identify call was actually sent.
 */
export function identifyHotjarUser(user) {
  if (!isHotjarEnabled()) return false;
  if (typeof window === 'undefined' || typeof window.hj !== 'function') return false;

  // Lowercased to match the case-insensitive email rule this codebase follows elsewhere. Without it,
  // one person signing in as Jane.Doe@ and jane.doe@ appears as two different Hotjar users.
  const email = (user?.email || '').trim().toLowerCase();
  if (!email) return false;

  // name is what the Azure AD token gives us; role is carried only if a caller ever has one.
  window.hj('identify', email, { name: user.name || '', role: user.role || 'UNKNOWN' });
  return true;
}
