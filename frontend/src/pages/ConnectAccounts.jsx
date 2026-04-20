import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getAuthStatus,
  getGoogleOAuthUrl,
  signOutGoogle,
  getMicrosoftOAuthUrl,
  signOutMicrosoft,
} from '../services/api';

export default function ConnectAccounts() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState({ google: null, microsoft: null });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [googleTenant, setGoogleTenant] = useState('1');
  const [msTenant, setMsTenant] = useState('1');

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const res = await getAuthStatus();
      setStatus(res.data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const connected = searchParams.get('connected');
    const errorProvider = searchParams.get('error');
    const email = searchParams.get('email');
    const message = searchParams.get('message');

    if (connected) {
      const label = connected === 'google' ? 'Google Workspace' : 'Microsoft 365';
      showToast(`${label} connected${email ? ` — ${email}` : ''}`, 'success');
      setSearchParams({}, { replace: true });
    } else if (errorProvider) {
      const label = errorProvider === 'google' ? 'Google Workspace' : 'Microsoft 365';
      showToast(`${label} connection failed: ${message || 'Unknown error'}`, 'error');
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, showToast]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function handleConnect(provider) {
    try {
      let res;
      if (provider === 'google') {
        res = await getGoogleOAuthUrl(undefined, googleTenant);
      } else {
        res = await getMicrosoftOAuthUrl(undefined, msTenant);
      }
      window.location.href = res.data.url;
    } catch (err) {
      showToast(`Failed to start ${provider} OAuth: ${err.response?.data?.error || err.message}`, 'error');
    }
  }

  async function handleSignOut(provider, email) {
    try {
      if (provider === 'google') {
        await signOutGoogle(email);
      } else {
        await signOutMicrosoft(email);
      }
      showToast(`Disconnected successfully`, 'success');
      await loadStatus();
    } catch (err) {
      showToast(`Sign out failed: ${err.message}`, 'error');
    }
  }

  const google = status.google;
  const microsoft = status.microsoft;

  return (
    <div className="max-w-3xl mx-auto">
      {toast && (
        <div
          className="fixed top-5 right-5 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all"
          style={{ backgroundColor: '#0129ac' }}
        >
          {toast.msg}
        </div>
      )}

      <div className="mb-8">
        <h1 className="text-2xl font-bold" style={{ color: '#0129ac' }}>Connect Accounts</h1>
        <p className="mt-1 text-sm" style={{ color: '#4a65c0' }}>
          Sign in to Google Workspace and Microsoft 365 to allow the agent to access mailboxes
          without hardcoding credentials.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-sm" style={{ color: '#4a65c0' }}>
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Loading…
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: '#4a65c0' }}>Google tenant:</span>
              <select
                value={googleTenant}
                onChange={(e) => setGoogleTenant(e.target.value)}
                className="text-xs rounded-lg px-2 py-1 bg-white outline-none"
                style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
              >
                <option value="1">cloudfuze.us</option>
                <option value="2">storefuze.com</option>
              </select>
            </div>
            <ProviderCard
              logo={<GoogleLogo />}
              name="Google Workspace"
              description="Connect a Google account to enable Gmail and Google Calendar access. Each account you connect can be used for mailbox operations."
              connected={google?.connected}
              connectedEmails={google?.emails || []}
              onConnect={() => handleConnect('google')}
              onSignOut={(email) => handleSignOut('google', email)}
              connectLabel="Connect Google Account"
              multiAccount
            />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-xs font-medium" style={{ color: '#4a65c0' }}>Microsoft tenant:</span>
              <select
                value={msTenant}
                onChange={(e) => setMsTenant(e.target.value)}
                className="text-xs rounded-lg px-2 py-1 bg-white outline-none"
                style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
              >
                <option value="1">gajha.com</option>
                <option value="2">filefuze.co</option>
              </select>
            </div>
            <ProviderCard
              logo={<MicrosoftLogo />}
              name="Microsoft 365"
              description="Connect a Microsoft 365 account to enable Outlook and Exchange access. For tenant-wide access, ensure your Azure AD app has application-level permissions."
              connected={microsoft?.connected}
              connectedEmails={microsoft?.emails || []}
              onConnect={() => handleConnect('microsoft')}
              onSignOut={(email) => handleSignOut('microsoft', email)}
              connectLabel="Connect Microsoft Account"
              multiAccount
            />
          </div>
        </div>
      )}

      <div className="mt-8 rounded-xl p-4 text-sm" style={{ border: '1px solid #c5cef5', backgroundColor: '#eef1fb', color: '#0129ac' }}>
        <div className="flex gap-2">
          <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          <div>
            <strong>Credentials in .env still work</strong> — OAuth-connected accounts take priority. Env-based credentials
            (GOOGLE_ACCOUNTS, GRAPH_CLIENT_ID…) remain as fallback and are not removed.
          </div>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({ logo, name, description, connected, connectedEmails, onConnect, onSignOut, connectLabel, multiAccount = false }) {
  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #c5cef5' }}>
      <div className="p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ border: '1px solid #eef1fb', backgroundColor: '#f5f7fd' }}>
            {logo}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-base font-semibold" style={{ color: '#0129ac' }}>{name}</h2>
              <ConnectedBadge connected={connected} />
            </div>
            <p className="text-sm leading-relaxed" style={{ color: '#4a65c0' }}>{description}</p>
          </div>
        </div>
      </div>

      {connected && connectedEmails.length > 0 && (
        <div className="px-6 py-4 space-y-2" style={{ borderTop: '1px solid #eef1fb', backgroundColor: '#f5f7fd' }}>
          {connectedEmails.map((email) => (
            <div key={email} className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm" style={{ color: '#0129ac' }}>
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20" style={{ color: '#0129ac' }}>
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
                <span className="font-medium">{email}</span>
              </div>
              <button
                onClick={() => onSignOut(email)}
                className="text-xs transition-colors"
                style={{ color: '#7a8fd4' }}
              >
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: '1px solid #eef1fb' }}>
        <span className="text-xs" style={{ color: '#7a8fd4' }}>
          {connected
            ? `${connectedEmails.length} account${connectedEmails.length !== 1 ? 's' : ''} connected`
            : 'Not connected'}
        </span>
        <div className="flex items-center gap-2">
          {connected && !multiAccount && (
            <button
              onClick={() => onSignOut(connectedEmails[0])}
              className="text-sm px-3 py-1.5 rounded-lg transition-colors"
              style={{ border: '1px solid #c5cef5', color: '#0129ac' }}
            >
              Sign Out
            </button>
          )}
          <button
            onClick={onConnect}
            className="text-sm px-4 py-1.5 rounded-lg text-white font-medium transition-colors"
            style={{ backgroundColor: '#0129ac' }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = '#011e8a'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = '#0129ac'}
          >
            {multiAccount && connected ? '+ Add Account' : connectLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectedBadge({ connected }) {
  if (connected) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: '#eef1fb', color: '#0129ac' }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#0129ac' }}></span>
        Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: '#f5f7fd', color: '#7a8fd4' }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#c5cef5' }}></span>
      Not connected
    </span>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="w-7 h-7">
      <path fill="#4285F4" d="M46.145 24.504c0-1.613-.134-3.167-.389-4.658H24v8.814h12.449c-.537 2.895-2.168 5.348-4.62 6.994v5.816h7.48c4.376-4.03 6.836-9.968 6.836-16.966z" />
      <path fill="#34A853" d="M24 48c6.24 0 11.473-2.065 15.298-5.597l-7.48-5.816c-2.072 1.39-4.724 2.21-7.818 2.21-6.012 0-11.1-4.062-12.921-9.516H3.324v6.009A23.998 23.998 0 0024 48z" />
      <path fill="#FBBC05" d="M11.079 29.281A14.416 14.416 0 0110.25 24c0-1.837.316-3.619.829-5.281v-6.009H3.324A23.998 23.998 0 000 24c0 3.867.927 7.53 2.563 10.71l.761-.588 7.48-5.816-.725.975z" />
      <path fill="#EA4335" d="M24 9.503c3.387 0 6.428 1.164 8.82 3.451l6.615-6.615C35.469 2.378 30.24 0 24 0A23.998 23.998 0 002.563 13.29l8.516 6.429C12.9 13.565 17.988 9.503 24 9.503z" />
    </svg>
  );
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 23 23" className="w-6 h-6">
      <rect x="1" y="1" width="10" height="10" fill="#F25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7FBA00" />
      <rect x="1" y="12" width="10" height="10" fill="#00A4EF" />
      <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
    </svg>
  );
}
