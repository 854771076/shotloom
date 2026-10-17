// 关闭确认守卫：桌面窗口请求关闭时，先把"有没有未保存改动"和"有没有仍在运行的 Agent"
// 变成一次明确的确认，再放行原生层。它属于应用生命周期，不是 React Hook——
// 根组件挂载时注册一次，卸载时执行返回的清理函数。
import { desktopApi } from "@/services/desktopApi";
import { getAgentRuntimeHealth } from "@/agent/runtime/runStore";
import { flushAutoSave, saveProject, store } from "@/store/projectStore";
import { showToast } from "@/store/notificationStore";

// 桌面桥的回执与异常按松散 JSON 读取。
type AnyRecord = Record<string, any>;

let cleanCloseSnapshot = "";
let windowCloseDisposable: (() => void) | undefined;

function createCloseSnapshot() {
  return JSON.stringify({
    project: store.project,
    projectDir: store.projectDir,
    filePath: store.filePath,
  });
}

// 保存成功或打开新项目之后把当前状态记为"干净"；快照为空表示还没有基准，不报未保存。
function markProjectClean() {
  cleanCloseSnapshot = createCloseSnapshot();
}

function hasUnsavedProjectChanges() {
  return Boolean(cleanCloseSnapshot) && cleanCloseSnapshot !== createCloseSnapshot();
}

export function registerWindowCloseGuard() {
  if (windowCloseDisposable) return windowCloseDisposable;

  markProjectClean();
  windowCloseDisposable = desktopApi.window.onCloseRequested?.(async (action: string) => {
    try {
      const autoSaved = await flushAutoSave();
      if (autoSaved) markProjectClean();
      const runtimeHealth = getAgentRuntimeHealth();
      if (!runtimeHealth.safeToClose) {
        const shouldInterrupt = window.confirm(
          `当前项目仍有运行中的工作：\n${runtimeHealth.blockingReasons.map((reason) => `• ${reason}`).join('\n')}\n\n仍然关闭会中断当前运行；已保存的待处理问题可以在重新打开项目后继续。是否仍要关闭？`,
        );
        if (!shouldInterrupt) {
          await desktopApi.window.cancelClose?.();
          return;
        }
      }
      if (hasUnsavedProjectChanges()) {
        const shouldSave = window.confirm('项目有未保存的更改。点击"确定"保存后关闭，点击"取消"选择其他操作。');
        if (shouldSave) {
          const saved = await saveProject();
          if (saved) markProjectClean();
          if (!saved) {
            await desktopApi.window.cancelClose?.();
            return;
          }
        } else {
          const shouldDiscard = window.confirm("不保存当前更改并关闭窗口？");
          if (!shouldDiscard) {
            await desktopApi.window.cancelClose?.();
            return;
          }
        }
      }
      await desktopApi.window.confirmClose?.(action);
    } catch (error) {
      showToast((error as AnyRecord)?.message || "关闭窗口失败");
      await desktopApi.window.cancelClose?.();
    }
  });
  return windowCloseDisposable;
}
