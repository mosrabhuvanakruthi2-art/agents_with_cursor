// Microsoft login (PKCE) for the QA Agent tool.
//
// Browser-side half of the flow:
//   1. startMicrosoftLogin() — generate a PKCE verifier/challenge + state, redirect to Microsoft.
//   2. Microsoft redirects back to window.location.origin with ?code=&state=.
//   3. handleMicrosoftCallback() — verify state, return { code, verifier, redirectUri }.
//   4. main.jsx POSTs that to /api/auth/microsoft/exchange, which returns our app JWT.
//
// The redirect URI is always window.location.origin, so it MUST be registered as a
// redirect URI on the Azure AD app (e.g. http://localhost:3000 in dev).

const CLIENT_ID = import.meta.env.VITE_AZURE_CLIENT_ID;
const TENANT_ID = import.meta.env.VITE_AZURE_TENANT_ID || 'common';

const TOKEN_KEY = 'app_token';
const USER_KEY = 'app_user';
const VERIFIER_KEY = 'ms_pkce_verifier';
const STATE_KEY = 'ms_oauth_state';
export const LOGIN_ERROR_KEY = 'ms_login_error';

function base64urlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** Kick off the Microsoft login: build PKCE params and redirect the browser to Microsoft. */
export async function startMicrosoftLogin() {
  if (!CLIENT_ID) {
    throw new Error('VITE_AZURE_CLIENT_ID is not set — configure it in frontend/.env');
  }
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(digest);
  const state = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: window.location.origin,
    scope: 'openid profile email User.Read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });

  window.location.href =
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

/**
 * If the current URL is a Microsoft OAuth callback (?code=&state=), verify state and return
 * { code, verifier, redirectUri } for the backend exchange. Returns null on a normal page load.
 * Throws on OAuth error or CSRF state mismatch. Always cleans the OAuth params off the URL.
 */
export async function handleMicrosoftCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  const cleanUrl = () => window.history.replaceState({}, '', window.location.pathname);

  if (error) {
    cleanUrl();
    throw new Error(params.get('error_description') || error);
  }
  if (!code) return null; // normal page load

  const savedState = sessionStorage.getItem(STATE_KEY);
  if (!state || state !== savedState) {
    cleanUrl();
    throw new Error('OAuth state mismatch — possible CSRF, please try signing in again');
  }

  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  cleanUrl();

  return { code, verifier, redirectUri: window.location.origin };
}

export function getAppToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getAppUser() {
  try {
    return JSON.parse(sessionStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return Boolean(getAppToken());
}

export function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  window.location.href = '/';
}
