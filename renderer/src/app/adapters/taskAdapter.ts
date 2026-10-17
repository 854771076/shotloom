import {
  cancelTask,
  canRetryTask,
  clearTasks,
  isHistoricalModelTask,
  retryTask,
} from "../../store/taskStore.ts";
import { store } from "../../store/projectStore.ts";
import type { GenerationTask } from "../views/TasksView";

export function taskViewData(): GenerationTask[] {
  return (store.project.tasks || []).map((task: GenerationTask) => ({
    ...task,
    historical: isHistoricalModelTask(task),
    canRetry: canRetryTask(task),
  }));
}
export const taskController = {
  cancel: cancelTask,
  retry: retryTask,
  clear: clearTasks,
};
