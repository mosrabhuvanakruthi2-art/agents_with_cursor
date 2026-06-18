import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useRunWizard from '../hooks/useRunWizard';
import useAgentExecution from '../hooks/useAgentExecution';
import {
  Stepper, StepConnect, StepSelect, StepMap, StepServer, StepOptions, StepSummary,
} from '../components/runwizard/steps';

const STEPS = ['Connect', 'Source & Destination', 'Map Users', 'Migration Server', 'Options', 'Summary'];

export default function RunAgent() {
  const wiz = useRunWizard();
  const { run, loading } = useAgentExecution();
  const navigate = useNavigate();
  const [runError, setRunError] = useState(null);

  const canAdvance = {
    1: true,
    2: !!(wiz.srcEmail && wiz.dstEmail),
    3: wiz.selectedPairs.length > 0,
    4: true,
    5: true,
    6: true,
  }[wiz.step];

  async function handleRun() {
    setRunError(null);
    try {
      const data = await run(wiz.buildPayload());
      const id = data?.executionId || data?.results?.[0]?.context?.executionId || data?.results?.[0]?.executionId;
      navigate(id ? `/logs?id=${encodeURIComponent(id)}` : '/logs');
    } catch (err) {
      setRunError(err.response?.data?.error || err.message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Run Agent</h1>
          <p className="text-sm text-gray-500 mt-1">Configure and trigger a migration QA flow</p>
        </div>
        <button type="button" onClick={() => { if (confirm('Reset the wizard?')) wiz.reset(); }}
          className="text-xs text-gray-500 hover:text-red-500">Reset</button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col h-[calc(100vh-13rem)]">
        {/* Only allow jumping back to the current or earlier steps — never skip ahead */}
        <Stepper steps={STEPS} current={wiz.step} maxReached={wiz.step} onJump={wiz.setStep} />

        {/* Static top navigation — stays visible while the step content scrolls below */}
        <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
          <button type="button" disabled={wiz.step === 1} onClick={() => wiz.setStep(wiz.step - 1)}
            className="inline-flex items-center gap-1 px-5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            ← Back
          </button>
          {wiz.step < 6 ? (
            <button type="button" disabled={!canAdvance} onClick={() => wiz.setStep(wiz.step + 1)}
              className="px-6 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              Next →
            </button>
          ) : (
            <span className="text-xs text-gray-400">Run from the summary below</span>
          )}
        </div>

        {runError && <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{runError}</div>}

        <div className="flex-1 min-h-0 overflow-y-auto pr-1">
          {wiz.step === 1 && <StepConnect wiz={wiz} />}
          {wiz.step === 2 && <StepSelect wiz={wiz} />}
          {wiz.step === 3 && <StepMap wiz={wiz} />}
          {wiz.step === 4 && <StepServer wiz={wiz} />}
          {wiz.step === 5 && <StepOptions wiz={wiz} />}
          {wiz.step === 6 && <StepSummary wiz={wiz} onRun={handleRun} running={loading} />}
        </div>
      </div>
    </div>
  );
}
