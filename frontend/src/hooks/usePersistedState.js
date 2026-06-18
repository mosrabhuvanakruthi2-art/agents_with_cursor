import { useState, useEffect, useRef } from 'react';

// State persisted to localStorage so it survives a full page refresh (not just
// in-app navigation). A small in-memory cache avoids re-parsing on every mount.
const cache = new Map();
const PREFIX = 'cf:';

function readInitial(key, initialValue) {
  if (cache.has(key)) return cache.get(key);
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      cache.set(key, parsed);
      return parsed;
    }
  } catch {
    /* unparseable / unavailable storage — fall back to initialValue */
  }
  return initialValue;
}

export default function usePersistedState(key, initialValue) {
  // readInitial restores from the in-memory cache AND localStorage (survives full refresh).
  const [value, setValue] = useState(() => readInitial(key, initialValue));
  const prevKeyRef = useRef(key);

  // When the key changes (e.g. mode switch), reinitialise from the new key's stored value.
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      setValue(readInitial(key, initialValue));
    }
  }, [key, initialValue]);

  useEffect(() => {
    cache.set(key, value);
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* quota exceeded or non-serializable value — keep in-memory only */
    }
  }, [key, value]);

  return [value, setValue];
}
