import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { handleMicrosoftCallback, LOGIN_ERROR_KEY } from './services/msalOauth';

async function bootstrap() {
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

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>
  );
}

bootstrap();
