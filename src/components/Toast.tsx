import React from 'react';
import { useToastStore } from '@/stores/toastStore';

const iconMap = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

const colorMap = {
  success: 'bg-green-600',
  error: 'bg-red-600',
  info: 'bg-blue-600',
  warning: 'bg-amber-600',
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${colorMap[t.type]} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-slide-in`}
        >
          <span className="text-sm font-bold">{iconMap[t.type]}</span>
          <span className="text-sm flex-1">{t.message}</span>
          <button
            onClick={() => removeToast(t.id)}
            className="text-white/70 hover:text-white text-sm ml-2"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
