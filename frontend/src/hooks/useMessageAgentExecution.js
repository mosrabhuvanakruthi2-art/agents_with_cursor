import { useState, useEffect } from 'react';
import {
  subscribe, getState, runExecution,
  subscribeSeed, getSeedState, runSeed,
  subscribeMigrate, getMigrateState, runMigrate,
} from '../services/messageExecutionStore';

export default function useMessageAgentExecution() {
  const [state, setState] = useState(getState);
  const [seedState, setSeedState] = useState(getSeedState);
  const [migrateState, setMigrateState] = useState(getMigrateState);

  useEffect(() => {
    const u1 = subscribe(() => setState(getState()));
    const u2 = subscribeSeed(() => setSeedState(getSeedState()));
    const u3 = subscribeMigrate(() => setMigrateState(getMigrateState()));
    return () => { u1(); u2(); u3(); };
  }, []);

  return {
    ...state,
    run: runExecution,
    seed: runSeed,
    migrate: runMigrate,
    seedExecution: seedState.execution,
    seedLoading: seedState.loading,
    seedError: seedState.error,
    migrateExecution: migrateState.execution,
    migrateLoading: migrateState.loading,
    migrateError: migrateState.error,
  };
}
