import { useState, useEffect } from 'react';
import { subscribe, getState, runExecution } from '../services/executionStore';

export default function useAgentExecution() {
  const [state, setState] = useState(getState);

  useEffect(() => {
    // Sync with store on mount and whenever store changes
    const unsubscribe = subscribe(() => setState(getState()));
    return unsubscribe;
  }, []);

  return { ...state, run: runExecution };
}
