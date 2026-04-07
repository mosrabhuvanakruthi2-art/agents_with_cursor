import { useState, useEffect } from 'react';

const cache = new Map();

export default function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(() => cache.has(key) ? cache.get(key) : initialValue);

  useEffect(() => {
    cache.set(key, value);
  }, [key, value]);

  return [value, setValue];
}
