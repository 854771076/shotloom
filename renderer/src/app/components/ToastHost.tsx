import { useNotificationStore } from "../../store/notificationStore";

export function ToastHost() {
  const toast = useNotificationStore((state) => state.toast);
  const tone = useNotificationStore((state) => state.toastTone);
  return toast ? (
    <div className={`toast${tone === "success" ? " toast-success" : ""}`} role="status">
      {tone === "success" && <span className="toast-success-mark" aria-hidden="true">✓</span>}
      <span>{toast}</span>
    </div>
  ) : null;
}
