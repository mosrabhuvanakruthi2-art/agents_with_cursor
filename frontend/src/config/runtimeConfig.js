// Resolves client-side configuration runtime-first, build-time second.
//
// Vite freezes `import.meta.env.VITE_*` into the bundle at build time, so a bundle built without a
// Hotjar ID could never be switched on and one built with it could never be un-tracked. Reading
// public/runtime-config.js at page load is what makes the value changeable after a build.

function runtimeBag() {
  return typeof window !== 'undefined' && window.__APP_CONFIG__ ? window.__APP_CONFIG__ : {};
}

// Treated as "not set": undefined, null, blank, and the "__PLACEHOLDER__" shape that container
// entrypoints substitute at start-up -- an unsubstituted placeholder must fall through, not be used.
function isUnset(v) {
  if (typeof v !== 'string') return true;
  const t = v.trim();
  return !t || /^__.*__$/.test(t);
}

function resolve(runtimeValue, buildTimeValue) {
  for (const raw of [runtimeValue, buildTimeValue]) {
    if (!isUnset(raw)) return raw.trim();
  }
  return '';
}

// Read at call time, not module-eval time, so editing public/runtime-config.js takes effect on the
// next page load, and so this stays testable without a module-registry reset.
export function resolveHotjarSiteId() {
  return resolve(runtimeBag().hotjarSiteId, import.meta.env?.VITE_HOTJAR_SITE_ID);
}

export const HOTJAR_SITE_ID = resolveHotjarSiteId();
