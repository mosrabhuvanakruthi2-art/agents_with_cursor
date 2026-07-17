import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useRunWizard from '../hooks/useRunWizard';
import useAgentExecution from '../hooks/useAgentExecution';
import {
  Stepper, StepSelect, StepMap, StepServer, StepOptions, StepSummary,
} from '../components/runwizard/steps';
import { DOMAIN_LIST, DOMAINS } from '../components/runwizard/domains';
import MessageWizard from '../components/MessageWizard';

const STEPS = ['Source & Destination', 'Map Users', 'Migration Server', 'Options', 'Summary'];

export default function RunAgent() {
  const wiz = useRunWizard();
  const { run, loading } = useAgentExecution();
  const navigate = useNavigate();
  const [runError, setRunError] = useState(null);
  const [msgResetToken, setMsgResetToken] = useState(0);

  const domainCfg = DOMAINS[wiz.domain] || DOMAINS.mail;

  const canAdvance = {
    1: !!(wiz.srcEmail && wiz.dstEmail),
    2: wiz.selectedPairs.length > 0,
    3: true,
    4: true,
    5: true,
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
        <button type="button" onClick={() => {
            if (confirm('Reset the wizard?')) {
              if (wiz.domain === 'message') setMsgResetToken((t) => t + 1);
              else wiz.reset();
            }
          }}
          className="text-xs text-gray-500 hover:text-red-500">Reset</button>
      </div>

      {/* Domain tabs — Mail / Content (Message later). Switching resets the wizard. */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {DOMAIN_LIST.map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => wiz.setDomain(d.key)}
            className={`px-5 py-2 rounded-lg text-sm font-semibold transition-all ${
              wiz.domain === d.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {domainCfg.ownPanel && wiz.domain === 'message' ? (
        <MessageWizard resetToken={msgResetToken} />
      ) : domainCfg.comingSoon ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 flex flex-col items-center justify-center text-center gap-3 h-[calc(100vh-16rem)]">
          <span className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center">
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M8 10.5h8M8 14h5m-9 6 3.5-2H18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14Z" /></svg>
          </span>
          <h2 className="text-xl font-bold text-gray-900">{domainCfg.label} migration — coming soon</h2>
          <p className="text-sm text-gray-500 max-w-md">Message migration (Slack, Teams, Google Chat, Webex, and more) isn't available yet. It'll appear here once the connectors are ready.</p>
        </div>
      ) : (
      <div className="bg-white rounded-xl border border-gray-200 p-6 flex flex-col h-[calc(100vh-16rem)]">
        {/* Only allow jumping back to the current or earlier steps — never skip ahead */}
        <Stepper steps={STEPS} current={wiz.step} maxReached={wiz.step} onJump={wiz.setStep} />

        {/* Static top navigation — stays visible while the step content scrolls below */}
        <div className="flex items-center justify-between border-b border-gray-100 pb-4 mb-4">
          <button type="button" disabled={wiz.step === 1} onClick={() => wiz.setStep(wiz.step - 1)}
            className="inline-flex items-center gap-1 px-5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg shadow-sm hover:bg-gray-50 hover:border-gray-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            ← Back
          </button>
          {wiz.step < 5 ? (
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
          {wiz.step === 1 && <StepSelect wiz={wiz} />}
          {wiz.step === 2 && <StepMap wiz={wiz} />}
          {wiz.step === 3 && <StepServer wiz={wiz} />}
          {wiz.step === 4 && <StepOptions wiz={wiz} />}
          {wiz.step === 5 && <StepSummary wiz={wiz} onRun={handleRun} running={loading} />}
        </div>
      </div>
      )}
    </div>
  );
}
