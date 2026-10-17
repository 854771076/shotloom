import { create } from 'zustand';

export type ToastTone = 'default' | 'success';

interface NotificationState {
  toast: string;
  toastTone: ToastTone;
  toastTimer: number | null;
  showToast: (message: string, tone?: ToastTone) => void;
}

const toastDuration: Record<ToastTone, number> = { default: 2400, success: 3600 };

// 提示条是跨层可达的应用级状态：store 和 app 都要能触发它，所以状态只能放在 store 这一层，
// 不能留在界面浮层里让数据层反向依赖界面。
export const useNotificationStore = create<NotificationState>((set, get) => ({
  toast: '',
  toastTone: 'default',
  toastTimer: null,
  showToast: (message, tone = 'default') => {
    const timer = get().toastTimer;
    if (timer) window.clearTimeout(timer);
    set({
      toast: String(message || ''),
      toastTone: tone,
      toastTimer: window.setTimeout(
        () => set({ toast: '', toastTone: 'default', toastTimer: null }),
        toastDuration[tone],
      ),
    });
  },
}));

export const showToast = (message: string, tone?: ToastTone) =>
  useNotificationStore.getState().showToast(message, tone);
export const showSuccessToast = (message: string) =>
  useNotificationStore.getState().showToast(message, 'success');
