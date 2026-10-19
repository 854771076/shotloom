import { create } from "zustand";

/**
 * 斜杠命令的界面状态：每个面板各自的输入草稿与 '/' 候选面板开合。
 *
 * 这是纯界面态，不是持久事实。goal 与 plan 的真实状态永远保存在 store.project 上
 * （services/agentConversations 的项目级 CAS 动词），本 store 不得写 project.goal 或 project.planMode。
 *
 * 状态按 panelKey 分片：画布、剪辑、文本三个面板可能同时挂载，草稿绝不能跨面板共享，
 * 否则会串到另一个面板的输入框里。panelKey 由调用方（agentId + conversationId）唯一确定一个面板。
 */

interface SlashPalette {
  query: string;
  index: number;
}

interface PanelUi {
  draft: string;
  slash: SlashPalette | null;
}

const EMPTY_PANEL: PanelUi = { draft: "", slash: null };

interface GoalPlanUIState {
  panels: Record<string, PanelUi>;
  panel: (key: string) => PanelUi;
  setDraft: (key: string, value: string) => void;
  setSlash: (key: string, next: SlashPalette | null) => void;
  clearPanel: (key: string) => void;
}

export const useGoalPlanStore = create<GoalPlanUIState>((set, get) => ({
  panels: {},
  panel: (key) => get().panels[key] || EMPTY_PANEL,
  setDraft: (key, value) =>
    set((state) => ({
      panels: { ...state.panels, [key]: { ...(state.panels[key] || EMPTY_PANEL), draft: value } },
    })),
  setSlash: (key, next) =>
    set((state) => ({
      panels: { ...state.panels, [key]: { ...(state.panels[key] || EMPTY_PANEL), slash: next } },
    })),
  clearPanel: (key) =>
    set((state) => {
      if (!state.panels[key]) return state;
      const { [key]: _drop, ...rest } = state.panels;
      return { panels: rest };
    }),
}));
