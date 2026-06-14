import React from 'react';
import { useConfirmStore } from '@/stores/confirmStore';

const variantColors = {
  danger: 'bg-red-600 hover:bg-red-700',
  warning: 'bg-amber-600 hover:bg-amber-700',
  info: 'bg-blue-600 hover:bg-blue-700',
};

export function ConfirmDialog() {
  const state = useConfirmStore();
  const { open, title, message, confirmText, cancelText, variant, resolve } = state;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => resolve(false)} />
      <div className="relative bg-zinc-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <h3 className="text-white text-lg font-semibold mb-3">{title}</h3>
        <p className="text-zinc-300 text-sm whitespace-pre-line mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button
            onClick={() => resolve(false)}
            className="px-4 py-2 rounded text-sm text-zinc-300 bg-zinc-700 hover:bg-zinc-600"
          >
            {cancelText}
          </button>
          <button
            onClick={() => resolve(true)}
            className={`px-4 py-2 rounded text-sm text-white ${variantColors[variant]}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
