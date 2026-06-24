import { create } from 'zustand';

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, 'id'>) => void;
  removeToast: (id: string) => void;
}

let toastId = 0;
// L-16: 维护 timer 引用，手动关闭时清除定时器，避免无操作的状态更新
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = String(++toastId);
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    const duration = toast.duration ?? (toast.type === 'error' ? 5000 : 3000);
    const timer = setTimeout(() => {
      toastTimers.delete(id);
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, duration);
    toastTimers.set(id, timer);
  },
  removeToast: (id) => {
    // L-16: 手动关闭时清除定时器，避免后续无操作的状态更新
    const timer = toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      toastTimers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(type: ToastItem['type'], message: string, duration?: number) {
  useToastStore.getState().addToast({ type, message, duration });
}
