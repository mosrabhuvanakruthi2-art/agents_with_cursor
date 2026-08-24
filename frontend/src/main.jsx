import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { handleMicrosoftCallback, getAppUser, LOGIN_ERROR_KEY } from './services/msalOauth';
import { initHotjar, identifyHotjarUser } from './analytics/hotjar.js';

async function bootstrap() {
  // Ahead of the await below so the hj() queue exists early: the identify call at the end of
  // bootstrap is then replayed once the remote script loads, instead of being dropped. No-ops
  // when no Hotjar site ID is configured.
  initHotjar();

  // If Microsoft redirected us back with ?code=, exchange it for our app JWT BEFORE rendering,
  // so the app boots straight into an authenticated state (and the URL is cleaned up).
  try {
    const callback = await handleMicrosoftCallback();
    if (callback) {
      const res = await fetch('/api/auth/microsoft/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callback),
      });
      const text = await res.text();
      const ctype = res.headers.get('content-type') || '';
      if (!ctype.includes('application/json')) {
        // Almost always: the backend hasn't been restarted, so /api/auth/microsoft/exchange
        // 404s and Express returns an HTML page. Surface a clear, actionable message.
        throw new Error(
          `Sign-in endpoint returned HTTP ${res.status} (non-JSON). ` +
          `Restart the backend so POST /api/auth/microsoft/exchange is available.`
        );
      }
      const data = text ? JSON.parse(text) : {};
      if (data.token) {
        sessionStorage.setItem('app_token', data.token);
        if (data.user) sessionStorage.setItem('app_user', JSON.stringify(data.user));
        sessionStorage.removeItem(LOGIN_ERROR_KEY);
      } else {
        sessionStorage.setItem(LOGIN_ERROR_KEY, data.error || 'Microsoft sign-in failed');
      }
    }
  } catch (err) {
    sessionStorage.setItem(LOGIN_ERROR_KEY, err.message);
  }

  // Tag the recording with the signed-in operator, after the exchange rather than on mount, so a
  // fresh sign-in is attributed from its first page view. Safe to call unauthenticated: with no
  // stored user this is a no-op, which is what the Login screen should be.
  //
  // Email is the right identifier here specifically because every user is a CloudFuze employee
  // arriving through single-tenant Azure AD. Note this is the *operator* driving the tool -- not
  // the mailbox addresses under migration, which are customer PII and must never be sent.
  identifyHotjarUser(getAppUser());

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>
  );
}

bootstrap();
