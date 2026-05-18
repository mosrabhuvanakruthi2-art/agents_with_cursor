import { NavLink } from 'react-router-dom';

const NAV_GROUPS = [
  {
    items: [
      { to: '/',              label: 'Dashboard',         icon: DashboardIcon },
      { to: '/message-agent', label: 'Message Agent',     icon: MessageAgentIcon },
      { to: '/run',           label: 'Run Agent',         icon: PlayIcon },
      { to: '/agent-repo',    label: 'Agent Repo',        icon: AgentRepoIcon },
    ],
  },
  {
    label: 'QA Tools',
    items: [
      { to: '/test-case-generator', label: 'Test Case Generator', icon: SparklesIcon },
      { to: '/test-repository',     label: 'Test Repository',     icon: FolderTreeIcon },
      { to: '/logs',                label: 'Execution Logs',      icon: LogsIcon },
      { to: '/validation',          label: 'Validation Results',  icon: CheckIcon },
    ],
  },
  {
    label: 'Migration',
    items: [
      { to: '/msg-migration', label: 'Msg Migration Status', icon: MigrationStatusIcon },
    ],
  },
  {
    label: 'Cleanup',
    items: [
      { to: '/clean',        label: 'Clean Destination', icon: CleanIcon },
      { to: '/clean-source', label: 'Clean Source',      icon: CleanSourceIcon },
      { to: '/clean-space',  label: 'Clean Msg Destination', icon: CleanSpaceIcon },
    ],
  },
];

/* ── Design tokens ──────────────────────────────────────────────────────────── */
const BLUE       = '#0129ac';
const BLUE_DARK  = '#011e8a';
const BLUE_DEEP  = '#010f5e';

export default function Sidebar({ collapsed, onToggle }) {
  return (
    <aside
      className={`relative flex-shrink-0 flex flex-col transition-all duration-250 ${collapsed ? 'w-[64px]' : 'w-[240px]'}`}
      style={{
        background: `linear-gradient(180deg, ${BLUE_DEEP} 0%, ${BLUE_DARK} 30%, ${BLUE} 100%)`,
        boxShadow: '4px 0 24px rgba(1,41,172,0.18)',
      }}
    >
      {/* ── Brand / Logo ────────────────────────────────────────────────── */}
      <div
        className={`flex items-center ${collapsed ? 'justify-center py-[22px] px-0' : 'px-5 py-[22px] gap-3'}`}
        style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}
      >
        {/* Logo mark */}
        <div
          className="flex-shrink-0 flex items-center justify-center rounded-xl font-black text-[15px]"
          style={{
            width: 36, height: 36,
            background: 'rgba(255,255,255,0.15)',
            border: '1.5px solid rgba(255,255,255,0.25)',
            color: '#fff',
            letterSpacing: '-0.5px',
          }}
        >
          MQ
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="font-bold text-white truncate" style={{ fontSize: 14, letterSpacing: '-0.2px' }}>
              Migration QA
            </div>
            <div className="truncate" style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 1 }}>
              Agent System
            </div>
          </div>
        )}
      </div>

      {/* ── Navigation ──────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden" style={{ padding: '8px 0' }}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} style={{ marginTop: gi > 0 ? 12 : 0 }}>

            {/* Section label */}
            {group.label && !collapsed && (
              <div style={{
                padding: '10px 20px 4px',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.35)',
              }}>
                {group.label}
              </div>
            )}
            {group.label && collapsed && (
              <div style={{
                margin: '8px 10px 4px',
                height: 1,
                background: 'rgba(255,255,255,0.1)',
              }} />
            )}

            {/* Nav items */}
            {group.items.map(item => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  title={collapsed ? item.label : undefined}
                  style={({ isActive }) => ({
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    margin: collapsed ? '2px 8px' : '2px 10px',
                    padding: collapsed ? '10px 0' : '9px 12px',
                    borderRadius: 9,
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 450,
                    color: isActive ? BLUE : 'rgba(255,255,255,0.7)',
                    backgroundColor: isActive ? '#fff' : 'transparent',
                    boxShadow: isActive ? '0 2px 8px rgba(1,41,172,0.25)' : 'none',
                    textDecoration: 'none',
                    transition: 'all 0.15s ease',
                    cursor: 'pointer',
                    position: 'relative',
                  })}
                  className="sidebar-nav-item"
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        style={{ width: 16, height: 16, flexShrink: 0, color: isActive ? BLUE : 'rgba(255,255,255,0.65)' }}
                      />
                      {!collapsed && (
                        <span className="truncate">{item.label}</span>
                      )}
                      {/* Active indicator dot */}
                      {isActive && !collapsed && (
                        <span style={{
                          marginLeft: 'auto',
                          width: 6, height: 6,
                          borderRadius: '50%',
                          background: BLUE,
                          flexShrink: 0,
                        }} />
                      )}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── User Profile ────────────────────────────────────────────────── */}
      <div
        className={`flex items-center ${collapsed ? 'justify-center px-0 py-4' : 'px-4 py-4 gap-3'}`}
        style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}
      >
        {/* Avatar */}
        <div style={{
          width: 34, height: 34,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #14b8a6, #0d9488)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 11, fontWeight: 700, flexShrink: 0,
          border: '2px solid rgba(255,255,255,0.25)',
        }}>
          NM
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div style={{ fontSize: 12, fontWeight: 600, color: '#fff', lineHeight: 1.3 }} className="truncate">
              Nagalakshmi Mangina
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 1 }} className="truncate">
              QA Team · CloudFuze
            </div>
          </div>
        )}
      </div>

      {/* ── Collapse toggle ──────────────────────────────────────────────── */}
      <button
        onClick={onToggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{
          position: 'absolute',
          right: -13,
          top: 68,
          zIndex: 20,
          width: 26, height: 26,
          borderRadius: '50%',
          background: '#fff',
          border: `2px solid ${BLUE}`,
          boxShadow: '0 2px 8px rgba(1,41,172,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer',
          transition: 'box-shadow 0.15s',
        }}
      >
        <svg
          style={{
            width: 11, height: 11, color: BLUE,
            transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
          }}
          fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
      </button>
    </aside>
  );
}

/* ── Icon Components ──────────────────────────────────────────────────────── */

function DashboardIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" />
    </svg>
  );
}
function PlayIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
    </svg>
  );
}
function MessageAgentIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
    </svg>
  );
}
function LogsIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    </svg>
  );
}
function CheckIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  );
}
function CleanIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
    </svg>
  );
}
function CleanSourceIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.338-2.32 5.25 5.25 0 0 1 1.675 10.045" />
    </svg>
  );
}
function CleanSpaceIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
    </svg>
  );
}
function FolderTreeIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
    </svg>
  );
}
function SparklesIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
    </svg>
  );
}
function AgentRepoIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" />
    </svg>
  );
}
function MigrationStatusIcon({ style }) {
  return (
    <svg style={style} fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0 0 20.25 18V6A2.25 2.25 0 0 0 18 3.75H6A2.25 2.25 0 0 0 3.75 6v12A2.25 2.25 0 0 0 6 20.25Z" />
    </svg>
  );
}
