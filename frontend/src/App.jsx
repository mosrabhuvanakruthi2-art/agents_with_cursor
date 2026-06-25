import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './context/ToastContext';
import Dashboard from './pages/Dashboard';
import Executions from './pages/Executions';
import TestCases from './pages/TestCases';
import RunAgent from './pages/RunAgent';
import ExecutionLogs from './pages/ExecutionLogs';
import CleanUpHub from './pages/CleanUpHub';
import TestRepository from './pages/TestRepository';
import ConnectClouds from './pages/ConnectClouds';
import OAuthCallback from './pages/OAuthCallback';
import CreateTestData from './pages/CreateTestData';

function App() {
  return (
    <ToastProvider>
    <Routes>
      {/* Standalone page — no sidebar, used as OAuth popup target */}
      <Route path="/oauth-callback" element={<OAuthCallback />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="executions" element={<Executions />} />
        <Route path="test-case-generator" element={<TestCases />} />
        <Route path="run" element={<RunAgent />} />
        <Route path="logs" element={<ExecutionLogs />} />
        {/* Validation Results merged into Reports & Logs */}
        <Route path="validation" element={<Navigate to="/logs" replace />} />
        {/* Unified Clean Up — Mail / Content / Message under one tabbed page */}
        <Route path="clean" element={<CleanUpHub />} />
        <Route path="clean-source" element={<Navigate to="/clean" replace />} />
        <Route path="clean-content" element={<Navigate to="/clean" replace />} />
        <Route path="clean-space" element={<Navigate to="/clean" replace />} />
        <Route path="test-repository" element={<TestRepository />} />
        {/* Test Case Generator + Agent Repo merged into one tabbed page */}
        <Route path="agent-repo" element={<Navigate to="/test-case-generator" replace />} />
        <Route path="connect" element={<ConnectClouds />} />
        <Route path="create-test-data" element={<CreateTestData />} />
      </Route>
    </Routes>
    </ToastProvider>
  );
}

export default App;

