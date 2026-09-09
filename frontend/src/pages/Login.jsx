import { useState } from 'react';
import { startMicrosoftLogin, LOGIN_ERROR_KEY } from '../services/msalOauth';

export default function Login() {
  // A sign-in error from the last redirect attempt is stashed by main.jsx.
  const initialError = sessionStorage.getItem(LOGIN_ERROR_KEY) || '';
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  if (initialError) sessionStorage.removeItem(LOGIN_ERROR_KEY);

  async function handleSignIn() {
    setError('');
    setBusy(true);
    try {
      await startMicrosoftLogin(); // redirects away
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-gray-100 p-8 text-center">
        <div className="w-14 h-14 mx-auto mb-5 rounded-2xl bg-indigo-600 flex items-center justify-center">
          <span className="text-white text-2xl font-bold">Q</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">QA Agent</h1>
        <p className="text-sm text-gray-500 mt-1 mb-8">Sign in to access the QA Agent tool</p>

        {error && (
          <div className="mb-5 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 text-left">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleSignIn}
          disabled={busy}
          className="w-full flex items-center justify-center gap-3 rounded-xl border-2 border-gray-200 bg-white px-4 py-3 text-sm font-semibold text-gray-800 hover:border-indigo-400 hover:bg-indigo-50 transition-colors disabled:opacity-60"
        >
          <svg width="20" height="20" viewBox="0 0 23 23" aria-hidden="true">
            <rect x="1" y="1" width="10" height="10" fill="#F25022" />
            <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
            <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
            <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
          </svg>
          {busy ? 'Redirecting to Microsoft…' : 'Sign in with Microsoft'}
        </button>

        <p className="text-xs text-gray-400 mt-6">Use your CloudFuze Microsoft account.</p>
      </div>
    </div>
  );
}
