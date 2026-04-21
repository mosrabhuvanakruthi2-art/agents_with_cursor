import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './context/ToastContext';
import Dashboard from './pages/Dashboard';
import TestCaseGenerator from './pages/TestCaseGenerator';
import RunAgent from './pages/RunAgent';
import ExecutionLogs from './pages/ExecutionLogs';
import ValidationResults from './pages/ValidationResults';
import CleanDestination from './pages/CleanDestination';
import CleanSource from './pages/CleanSource';
import CleanSpace from './pages/CleanSpace';
import TestRepository from './pages/TestRepository';
import AgentRepo from './pages/AgentRepo';
import ConnectAccounts from './pages/ConnectAccounts';
import OAuthCallback from './pages/OAuthCallback';

function App() {
  return (
    <ToastProvider>
    <Routes>
      {/* Standalone page — no sidebar, used as OAuth popup target */}
      <Route path="/oauth-callback" element={<OAuthCallback />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="test-case-generator" element={<TestCaseGenerator />} />
        <Route path="run" element={<RunAgent />} />
        <Route path="logs" element={<ExecutionLogs />} />
        <Route path="validation" element={<ValidationResults />} />
        <Route path="clean" element={<CleanDestination />} />
        <Route path="clean-source" element={<CleanSource />} />
        <Route path="clean-space" element={<CleanSpace />} />
        <Route path="test-repository" element={<TestRepository />} />
        <Route path="agent-repo" element={<AgentRepo />} />
        <Route path="connect" element={<ConnectAccounts />} />
      </Route>
    </Routes>
    </ToastProvider>
  );
}

export default App;

