import { useState, useEffect, useRef } from 'react';

const cache = new Map();

export default function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(() => cache.has(key) ? cache.get(key) : initialValue);
  const prevKeyRef = useRef(key);

  // When the key changes (e.g. mode switch), reinitialise state from the new key's cached value
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      const next = cache.has(key) ? cache.get(key) : initialValue;
      setValue(next);
    }
  }, [key, initialValue]);

  useEffect(() => {
    cache.set(key, value);
  }, [key, value]);

  return [value, setValue];
}
