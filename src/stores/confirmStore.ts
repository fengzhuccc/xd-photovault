import { create } from 'zustand';

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
  title: '确认',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  variant: 'warning',
  onConfirm: null,
  onCancel: null,

  showConfirm: (options) => {
    return new Promise<boolean>((resolve) => {
      resolveRef = resolve;
      set({
        open: true,
        title: options.title || '确认',
        message: options.message || '',
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
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
