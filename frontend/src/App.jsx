import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import RunAgent from './pages/RunAgent';
import ExecutionLogs from './pages/ExecutionLogs';
import ValidationResults from './pages/ValidationResults';
import CleanDestination from './pages/CleanDestination';
import CleanSource from './pages/CleanSource';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="run" element={<RunAgent />} />
        <Route path="logs" element={<ExecutionLogs />} />
        <Route path="validation" element={<ValidationResults />} />
        <Route path="clean" element={<CleanDestination />} />
        <Route path="clean-source" element={<CleanSource />} />
      </Route>
    </Routes>
  );
}

export default App;

