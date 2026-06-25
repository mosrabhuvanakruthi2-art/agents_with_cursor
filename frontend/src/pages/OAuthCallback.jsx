/**
 * Minimal page that OAuth popup windows are redirected to after sign-in.
 * Writes the result to localStorage so the opener window can pick it up, then closes itself.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export default function OAuthCallback() {
  const [params] = useSearchParams();
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const connected = params.get('connected');
    const email = params.get('email');
    const error = params.get('error');
    const message = params.get('message');

    if (connected && email) {
      localStorage.setItem(
        'cf_oauth_result',
        JSON.stringify({ connected, email, ts: Date.now() })
      );
    } else if (error) {
      localStorage.setItem(
        'cf_oauth_result',
        JSON.stringify({ error, message: message || error, ts: Date.now() })
      );
    }

    setClosing(true);
    // Give the storage event time to propagate before closing
    const t = setTimeout(() => window.close(), 300);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center space-y-3">
        {closing ? (
          <>
            <div className="w-12 h-12 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
              <svg className="w-6 h-6 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
              </svg>
            </div>
            <p className="text-sm font-medium text-gray-700">Authentication successful</p>
            <p className="text-xs text-gray-500">This window will close automatically…</p>
          </>
        ) : (
          <p className="text-sm text-gray-500">Processing…</p>
        )}
      </div>
    </div>
  );
}
