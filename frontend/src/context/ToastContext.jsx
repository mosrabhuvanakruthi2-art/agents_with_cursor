import { createContext, useContext, useState, useCallback, useRef } from 'react';

const ToastContext = createContext(null);

let _id = 0;

const ICONS = {
  success: (
    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
    </svg>
  ),
  error: (
    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
    </svg>
  ),
  warning: (
    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
    </svg>
  ),
  info: (
    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
    </svg>
  ),
};

const STYLES = {
  success: { wrap: { backgroundColor: '#fff', borderLeft: '4px solid #0129ac' }, icon: { color: '#0129ac' }, title: { color: '#011e8a' }, msg: { color: '#0129ac' } },
  error:   { wrap: { backgroundColor: '#fff', borderLeft: '4px solid #011e8a' }, icon: { color: '#011e8a' }, title: { color: '#011e8a' }, msg: { color: '#0129ac' } },
  warning: { wrap: { backgroundColor: '#eef1fb', borderLeft: '4px solid #0129ac' }, icon: { color: '#0129ac' }, title: { color: '#011e8a' }, msg: { color: '#0129ac' } },
  info:    { wrap: { backgroundColor: '#fff', borderLeft: '4px solid #4a65c0' },  icon: { color: '#4a65c0' }, title: { color: '#0129ac' }, msg: { color: '#2a40a8' } },
};

function Toast({ toast, onDismiss }) {
  const s = STYLES[toast.type] || STYLES.info;
  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg min-w-[280px] max-w-sm pointer-events-auto animate-[slideIn_0.2s_ease-out]"
      style={s.wrap}
    >
      <span style={s.icon}>{ICONS[toast.type]}</span>
      <div className="flex-1 min-w-0">
        {toast.title && <p className="text-sm font-semibold leading-tight" style={s.title}>{toast.title}</p>}
        {toast.message && <p className="text-xs mt-0.5 leading-snug" style={s.msg}>{toast.message}</p>}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="flex-shrink-0 transition-colors mt-0.5"
        style={{ color: '#7a8fd4' }}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((type, title, message, duration = 4000) => {
    const id = ++_id;
    setToasts((prev) => [...prev, { id, type, title, message }]);
    if (duration > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  const toast = {
    success: (title, message, duration) => show('success', title, message, duration),
    error:   (title, message, duration) => show('error',   title, message, duration),
    warning: (title, message, duration) => show('warning', title, message, duration),
    info:    (title, message, duration) => show('info',    title, message, duration),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed top-5 right-5 z-[9999] flex flex-col gap-2.5 pointer-events-none">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
