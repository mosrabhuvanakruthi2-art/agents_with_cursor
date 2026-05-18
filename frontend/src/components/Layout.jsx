import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#ffffff' }}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(p => !p)} />
      <main style={{
        flex: 1,
        overflowY: 'auto',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#ffffff',
        borderLeft: '1px solid #e8edf8',
      }}>
        <div style={{ flex: 1, padding: '28px 32px 32px', width: '100%', maxWidth: '100%' }}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
