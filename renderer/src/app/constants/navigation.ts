import type { IconName } from "../components/IconSymbol";
import type { AppRoute } from "../store/appStore";

export interface NavigationItem {
  id: AppRoute;
  label: string;
  icon: IconName;
  description: string;
}

export const projectWorkspaceItems: NavigationItem[] = [
  {
    id: "creation",
    label: "项目画布",
    icon: "grid",
    description: "编排节点与工作流",
  },
  {
    id: "tasks",
    label: "项目任务",
    icon: "task",
    description: "当前项目内的执行记录",
  },
];

export const nodeTypes = [
  { id: "imageGeneration", label: "图片生成", icon: "image" as const },
  { id: "videoGeneration", label: "视频生成", icon: "film" as const },
  { id: "threeDDirector", label: "3D导演台", icon: "box" as const },
  { id: "audioGeneration", label: "音频生成", icon: "waveform" as const },
  { id: "textGeneration", label: "文本生成", icon: "text" as const },
];
