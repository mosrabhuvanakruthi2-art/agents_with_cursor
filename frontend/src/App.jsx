import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { ToastProvider } from './context/ToastContext';
import Dashboard from './pages/Dashboard';
import Executions from './pages/Executions';
import TestCases from './pages/TestCases';
import RunAgent from './pages/RunAgent';
import ExecutionLogs from './pages/ExecutionLogs';
import CleanUp from './pages/CleanUp';
import ContentCleanUp from './pages/ContentCleanUp';
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
        <Route path="clean" element={<CleanUp />} />
        {/* Gmail + Outlook cleanup merged into one tabbed page */}
        <Route path="clean-source" element={<Navigate to="/clean" replace />} />
        {/* Content (Box/Drive) cleanup — brought in from dev */}
        <Route path="clean-content" element={<ContentCleanUp />} />
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

