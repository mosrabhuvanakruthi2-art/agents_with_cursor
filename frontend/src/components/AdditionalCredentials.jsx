import { useState, useEffect, useCallback } from 'react';
import { getCFLoginAccounts, addCFLoginAccount, removeCFLoginAccount } from '../services/api';

export default function AdditionalCredentials({ onCFAccountChange }) {
  const [open, setOpen]               = useState(false);
  const [accounts, setAccounts]       = useState([]);
  const [selected, setSelected]       = useState('');
  const [addEmail, setAddEmail]       = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [showPass, setShowPass]       = useState(false);
  const [adding, setAdding]           = useState(false);
  const [removing, setRemoving]       = useState('');
  const [error, setError]             = useState(null);
  const [success, setSuccess]         = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await getCFLoginAccounts();
      const list = Array.isArray(res?.data?.accounts) ? res.data.accounts : [];
      setAccounts(list);
      setSelected(prev => {
        const keep = prev && list.find(a => a.email === prev) ? prev : (list[0]?.email || '');
        if (keep !== prev) onCFAccountChange?.(keep);
        return keep;
      });
    } catch { setAccounts([]); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  function selectAccount(email) {
    setSelected(email);
    onCFAccountChange?.(email);
  }

  async function handleAdd(e) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (!addEmail.trim() || !addPassword.trim()) {
      setError('Email and password are required');
      return;
    }
    setAdding(true);
    try {
      await addCFLoginAccount(addEmail.trim(), addPassword.trim());
      setSuccess(`Added: ${addEmail.trim()}`);
      setAddEmail('');
      setAddPassword('');
      await load();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || 'Failed to add account');
    } finally { setAdding(false); }
  }

  async function handleRemove(email) {
    setRemoving(email);
    try {
      await removeCFLoginAccount(email);
      if (selected === email) {
        const remaining = accounts.filter(a => a.email !== email);
        const next = remaining[0]?.email || '';
        setSelected(next);
        onCFAccountChange?.(next);
      }
      await load();
    } catch { /* ignore */ } finally { setRemoving(''); }
  }

  return (
    <div style={{ borderRadius: 12, border: '1.5px solid #e4e9f5', overflow: 'hidden', backgroundColor: '#fff' }}>

      {/* ── Header ── */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 20px', background: 'linear-gradient(135deg, #f8faff 0%, #eef1fd 100%)',
          border: 'none', cursor: 'pointer', borderBottom: open ? '1px solid #e4e9f5' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, backgroundColor: '#eef1fd', border: '1px solid #c5cef5', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0129ac" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
              <line x1="12" y1="11" x2="12" y2="17"/>
              <line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0129ac' }}>CloudFuze Server Login</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
              Select or add an account used to log in to the CloudFuze migration portal
            </div>
          </div>
          {selected && (
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20, backgroundColor: '#0129ac', color: '#fff', marginLeft: 4, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selected}
            </span>
          )}
        </div>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}>
          <path d="M4 6l4 4 4-4" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* ── Body ── */}
      {open && (
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Account list */}
          {accounts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Select Login Account
              </div>
              {accounts.map(acc => (
                <div key={acc.email}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 9, border: `1.5px solid ${selected === acc.email ? '#0129ac' : '#e4e9f5'}`, backgroundColor: selected === acc.email ? '#eef1fd' : '#fafbff', cursor: 'pointer', transition: 'all 0.15s' }}
                  onClick={() => selectAccount(acc.email)}
                >
                  {/* radio dot */}
                  <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${selected === acc.email ? '#0129ac' : '#d1d5db'}`, backgroundColor: selected === acc.email ? '#0129ac' : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {selected === acc.email && <div style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#fff' }} />}
                  </div>

                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={selected === acc.email ? '#0129ac' : '#9ca3af'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>

                  <span style={{ flex: 1, fontSize: 13, fontWeight: selected === acc.email ? 700 : 500, color: selected === acc.email ? '#0129ac' : '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {acc.email}
                  </span>

                  {acc.source === 'env' && (
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4, backgroundColor: '#e0f2fe', color: '#0369a1', flexShrink: 0 }}>
                      primary
                    </span>
                  )}

                  {acc.source === 'user' && (
                    <button type="button"
                      disabled={removing === acc.email}
                      onClick={ev => { ev.stopPropagation(); handleRemove(acc.email); }}
                      style={{ flexShrink: 0, padding: '3px 8px', borderRadius: 6, border: '1px solid #fca5a5', backgroundColor: '#fff0f0', color: '#dc2626', fontSize: 11, fontWeight: 600, cursor: removing === acc.email ? 'not-allowed' : 'pointer', opacity: removing === acc.email ? 0.5 : 1 }}>
                      {removing === acc.email ? '…' : 'Remove'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add account form */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14, borderRadius: 10, backgroundColor: '#f8faff', border: '1.5px solid #e4e9f5' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0129ac' }}>Add Account</div>
            <p style={{ fontSize: 11, color: '#6b7280', margin: 0 }}>
              Enter CloudFuze portal credentials to add another login account for browser automation.
            </p>

            <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input
                type="email"
                value={addEmail}
                onChange={e => setAddEmail(e.target.value)}
                placeholder="user@example.com"
                autoComplete="off"
                style={{ padding: '9px 13px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff', color: '#111827' }}
              />

              <div style={{ position: 'relative' }}>
                <input
                  type={showPass ? 'text' : 'password'}
                  value={addPassword}
                  onChange={e => setAddPassword(e.target.value)}
                  placeholder="Password"
                  autoComplete="new-password"
                  style={{ width: '100%', padding: '9px 40px 9px 13px', borderRadius: 8, border: '1.5px solid #e5e7eb', fontSize: 13, outline: 'none', backgroundColor: '#fff', color: '#111827', boxSizing: 'border-box' }}
                />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#9ca3af' }}>
                  {showPass ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>

              {error && (
                <div style={{ padding: '8px 12px', borderRadius: 7, backgroundColor: '#fee2e2', border: '1px solid #fca5a5', fontSize: 12, color: '#dc2626' }}>
                  {error}
                </div>
              )}
              {success && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', borderRadius: 7, backgroundColor: '#f0fdf4', border: '1px solid #86efac', fontSize: 12, color: '#15803d', fontWeight: 600 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  {success}
                </div>
              )}

              <button type="submit" disabled={adding}
                style={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 20px', fontSize: 13, fontWeight: 700, borderRadius: 9, border: 'none', cursor: adding ? 'not-allowed' : 'pointer', backgroundColor: '#0129ac', color: '#fff', opacity: adding ? 0.6 : 1 }}>
                {adding ? (
                  <>
                    <svg style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25"/>
                      <path fill="currentColor" opacity="0.75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Adding…
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Account
                  </>
                )}
              </button>
            </form>
          </div>

        </div>
      )}
    </div>
  );
}
