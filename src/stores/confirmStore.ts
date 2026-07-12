import { create } from 'zustand';
import i18next from '@/i18n';

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  variant: 'danger' | 'warning' | 'info';
  onConfirm: (() => void) | null;
  onCancel: (() => void) | null;
}

interface ConfirmActions {
  showConfirm: (options: Partial<ConfirmState>) => Promise<boolean>;
  resolve: (value: boolean) => void;
}

let resolveRef: ((value: boolean) => void) | null = null;

export const useConfirmStore = create<ConfirmState & ConfirmActions>((set) => ({
  open: false,
  title: i18next.t('confirm.defaultTitle'),
  message: '',
  confirmText: i18next.t('confirm.defaultConfirm'),
  cancelText: i18next.t('confirm.defaultCancel'),
  variant: 'warning',
  onConfirm: null,
  onCancel: null,

  showConfirm: (options) => {
    return new Promise<boolean>((resolve) => {
      // H-18: 覆盖前先 resolve 前一个为 false，避免 Promise 永久挂起
      if (resolveRef) resolveRef(false);
      resolveRef = resolve;
      set({
        open: true,
        title: options.title || i18next.t('confirm.defaultTitle'),
        message: options.message || '',
        confirmText: options.confirmText || i18next.t('confirm.defaultConfirm'),
        cancelText: options.cancelText || i18next.t('confirm.defaultCancel'),
        variant: options.variant || 'warning',
        onConfirm: null,
        onCancel: null,
      });
    });
  },

  resolve: (value) => {
    set({ open: false });
    resolveRef?.(value);
    resolveRef = null;
  },
}));

export async function confirm(message: string, options?: { title?: string; confirmText?: string; cancelText?: string; variant?: 'danger' | 'warning' | 'info' }) {
  return useConfirmStore.getState().showConfirm({
    message,
    title: options?.title,
    confirmText: options?.confirmText,
    cancelText: options?.cancelText,
    variant: options?.variant,
  });
}
