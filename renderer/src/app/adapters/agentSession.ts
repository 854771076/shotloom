import { abortLoopAgent, runLoopAgent, steerLoopAgent } from "../../agent/loop/runLoopAgent";
import { getAgentProjectKey } from "../../services/agentProjectIdentity";
import { getActiveAgentConversation, titleConversationFromMessage } from "../../services/agentConversations.ts";
import { recordPerformanceMetric } from "../../services/performanceMetrics";
import { toRaw } from "../../store/domainReactivity.ts";
import { showToast } from "../../store/notificationStore";
import { store, touchProject } from "../../store/projectStore";
import { uid } from "../../utils/format";
import { AgentRuntimePresenter } from "../agent-session/runtimePresenter";
import type { AgentReference } from "../agent-chat/mediaReference";

type Loose = Record<string, any>;

export type AgentSendPayload = {
  text: string;
  model: string;
  attachments: unknown[];
  nodeMentions: unknown[];
  references?: AgentReference[];
  conversationId?: string;
};
export type AgentResume = {
  conversationId: string;
  payload: AgentSendPayload & { continuation: Loose };
};
type Delivery = {
  clientMessageId: string;
  payload: AgentSendPayload;
  resume?: AgentResume;
  skipUserMessage: boolean;
  conversationId: string;
  project: Loose;
  projectKey: string;
  userMessageId?: string;
};
type DeliverOptions = { skipUserMessage?: boolean; priority?: boolean };

/** 同时排队的后续投递上限：超过就是用户在堆任务，而不是运行时在保护自己。 */
const MAX_QUEUED_DELIVERIES = 3;

function activeConversation(): Loose {
  return getActiveAgentConversation(store.project) as Loose;
}

function conversationById(conversationId: string): Loose | null {
  if (!conversationId) return null;
  return ((store.project.agentConversations || []) as Loose[]).find(
    (item) => String(item.id) === conversationId,
  ) || null;
}

/**
 * 一个 Agent 面板会话的运行状态。
 *
 * "这一轮在跑吗""正在跑的是哪一轮、属于哪个会话""还有几条消息在排队"都是运行中的事实，
 * 不属于任何一条持久化会话记录，也不该散落在界面适配模块的顶层变量里：它们决定用户现在
 * 能不能改输入、补充指令要注入给谁、以及哪条消息算已被处理。
 */
export interface AgentSession {
  subscribe: (listener: () => void) => () => void;
  revision: () => number;
  notify: () => void;
  isBusy: () => boolean;
  /** 投递一条消息：运行中的纯文本指令注入当前这一轮，其余按到达顺序排队。 */
  deliver: (payload: AgentSendPayload, resume?: AgentResume, options?: DeliverOptions) => boolean;
  cancelActiveRun: () => void;
}

export function createAgentSession(): AgentSession {
  const listeners = new Set<() => void>();
  const deliveryQueue: Delivery[] = [];
  let revision = 0;
  let busy = false;
  let deliveryProcessing = false;
  let activeRequestId = "";
  // 注入必须同时匹配"哪一轮在跑"和"它属于哪个会话"，否则补充指令会写进另一个会话的历史。
  let runningConversationId = "";

  const notify = () => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };

  function pushMessage(message: Loose, targetConversation?: Loose) {
    const conversation = targetConversation || (toRaw(activeConversation()) as Loose);
    if (!busy) {
      conversation.messages = conversation.messages.filter((item: Loose) => !item.transient);
    }
    const id = String(message.id || uid());
    conversation.messages.push({
      id,
      createdAt: new Date().toISOString(),
      ...message,
    });
    if (message.role === "user") {
      titleConversationFromMessage(conversation, message.content);
    }
    conversation.updatedAt = new Date().toISOString();
    touchProject();
    notify();
    return id;
  }

  function pushTyping(targetConversation?: Loose) {
    const id = uid();
    const conversation = toRaw(targetConversation || activeConversation()) as Loose;
    conversation.messages.push({
      id,
      role: "assistant",
      title: "助手正在处理",
      content: "",
      typing: true,
      transient: true,
      createdAt: new Date().toISOString(),
    });
    notify();
    return id;
  }

  function patchMessage(id: string, patch: Loose, targetConversation?: Loose) {
    const conversation = toRaw(targetConversation || activeConversation()) as Loose;
    const item = conversation.messages.find((message: Loose) => message.id === id);
    if (item) Object.assign(item, patch);
    notify();
  }

  function finalizeMessage(id: string, patch: Loose, targetConversation?: Loose) {
    const conversation = toRaw(targetConversation || activeConversation()) as Loose;
    const item = conversation.messages.find((message: Loose) => message.id === id);
    if (!item) return pushMessage(patch, conversation);
    Object.assign(item, patch, {
      id: item.id,
      createdAt: item.createdAt,
      typing: false,
      transient: false,
    });
    conversation.updatedAt = new Date().toISOString();
    touchProject();
    notify();
  }

  function patchConversationMessage(conversationId: string, id: string, patch: Loose) {
    const conversation = (store.project.agentConversations || [])
      .find((item: Loose) => String(item.id || "") === conversationId);
    const message = conversation?.messages?.find((item: Loose) => item.id === id);
    if (!message) return;
    Object.assign(message, patch);
    conversation.updatedAt = new Date().toISOString();
    touchProject({ sessionDelay: 100, coalesceSession: true });
    notify();
  }

  async function send(
    payload: AgentSendPayload,
    resume?: AgentResume,
    options: { skipUserMessage?: boolean; delivery?: Delivery } = {},
  ) {
    const project = options.delivery?.project || store.project;
    const projectKey = options.delivery?.projectKey || getAgentProjectKey();
    const conversation = conversationById(String(payload.conversationId || "")) || activeConversation();
    if (resume && String(conversation.id || "") !== resume.conversationId) {
      showToast("待续跑的 Agent 属于另一个对话，请先切换回原对话");
      return;
    }
    const messageText = payload.text.trim() || "请结合我选择的节点和附件继续处理。";
    if (!resume && !options.skipUserMessage) {
      pushMessage({
        role: "user",
        title: "你的消息",
        content: messageText,
        references: [...(payload.references || [])],
      }, conversation);
    }
    const typingId = pushTyping(conversation);
    const presentation = new AgentRuntimePresenter();
    let timer = 0;
    let pendingPatch: Loose = {};
    let pendingContextUsage: Loose | null = null;
    let pendingEventCount = 0;
    let batchStartedAt = 0;
    const flush = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      if (!pendingEventCount && !Object.keys(pendingPatch).length && !pendingContextUsage) return;
      const startedAt = batchStartedAt || performance.now();
      if (pendingContextUsage) (toRaw(conversation) as Loose).contextUsage = pendingContextUsage;
      patchMessage(typingId, {
        content: presentation.streamed,
        typing: true,
        ...pendingPatch,
      }, conversation);
      recordPerformanceMetric("agent.stream.flush", startedAt, {
        eventCount: pendingEventCount,
        contentLength: presentation.streamed.length,
        toolCount: presentation.tools.length,
      });
      pendingPatch = {};
      pendingContextUsage = null;
      pendingEventCount = 0;
      batchStartedAt = 0;
    };
    const schedule = () => {
      if (!batchStartedAt) batchStartedAt = performance.now();
      pendingEventCount += 1;
      if (!timer) timer = window.setTimeout(flush, 32);
    };
    const stopTimer = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    };
    try {
      if (options.delivery?.userMessageId) {
        patchConversationMessage(options.delivery.conversationId, options.delivery.userMessageId, {
          deliveryStage: "sent",
        });
      }
      const result = await runLoopAgent(
        {
          message: messageText,
          model: payload.model,
          attachments: payload.attachments as Loose[],
          nodeMentions: payload.nodeMentions as Loose[],
          continuation: resume?.payload.continuation,
          projectKey,
          conversationId: conversation.id,
        } as any,
        (event: Loose) => {
          if (event.type === "run_started") {
            activeRequestId = String(event.requestId || "");
            runningConversationId = String(conversation.id || "");
            if (options.delivery?.userMessageId) {
              patchConversationMessage(options.delivery.conversationId, options.delivery.userMessageId, {
                deliveryStage: "started",
                requestId: activeRequestId,
              });
            }
          }
          if (store.project !== project || getAgentProjectKey() !== projectKey) return;
          const effect = presentation.consume(event);
          let shouldSchedule = effect.textChanged === true;
          if (effect.contextUsage) {
            pendingContextUsage = effect.contextUsage;
            shouldSchedule = true;
          }
          if (effect.messagePatch) {
            pendingPatch = { ...pendingPatch, ...effect.messagePatch };
            shouldSchedule = true;
          }
          if (shouldSchedule) schedule();
          if (effect.persist) {
            flush();
            touchProject();
          }
        },
      );
      if (store.project !== project || getAgentProjectKey() !== projectKey) {
        return;
      }
      conversation.contextUsage = result?.contextUsage || conversation.contextUsage || null;
      conversation.updatedAt = new Date().toISOString();
      if (options.delivery?.userMessageId) {
        patchConversationMessage(options.delivery.conversationId, options.delivery.userMessageId, {
          deliveryStage: "completed",
        });
      }
      flush();
      finalizeMessage(typingId, {
        role: "assistant",
        title: "画布助手",
        content: presentation.streamed || result?.reply || "Agent 已完成本轮处理。",
        ...presentation.snapshot(),
        requestId: result?.requestId || "",
      }, conversation);
    } catch (cause: any) {
      if (store.project === project && getAgentProjectKey() === projectKey) {
        flush();
        const error = String(cause?.message || cause || "未知错误");
        const cancelled = /abort|cancel/i.test(error);
        const diagnosis = cause?.diagnosis as Loose | undefined;
        if (options.delivery?.userMessageId) {
          patchConversationMessage(options.delivery.conversationId, options.delivery.userMessageId, {
            deliveryStage: cancelled ? "cancelled" : "failed",
            deliveryError: cancelled ? "" : error,
          });
        }
        finalizeMessage(typingId, {
          role: "assistant",
          title: cancelled ? "已停止" : "运行失败",
          content: presentation.streamed || (cancelled ? "已停止当前任务。" : ""),
          ...(cancelled
            ? {}
            : {
                error: diagnosis?.title ? `${diagnosis.title}：${diagnosis.message}` : `Agent 运行失败：${error}`,
                diagnosis,
                retryable: true,
                retryPayload: {
                  text: payload.text,
                  model: payload.model,
                  attachments: [...payload.attachments],
                  nodeMentions: [...payload.nodeMentions],
                },
              }),
          ...presentation.snapshot(presentation.failRunning()),
        }, conversation);
      }
    } finally {
      stopTimer();
      activeRequestId = "";
      runningConversationId = "";
    }
  }

  function deliver(
    payload: AgentSendPayload,
    resume?: AgentResume,
    options: DeliverOptions = {},
  ): boolean {
    // 面板发送必须显式带上目标会话；只有续跑/重试这类没有面板上下文的投递才回退到项目级活动会话。
    const conversation = conversationById(String(payload.conversationId || "")) || activeConversation();
    // 运行中的纯文本指令注入当前这一轮，下一步的模型请求就能看到它。带附件或节点引用的消息
    // 不是"一段补充话"，续跑与重试也不属于用户的新指令，这些都只能排到当前运行之后。
    const steeringText =
      !resume &&
      !options.skipUserMessage &&
      !options.priority &&
      !payload.attachments.length &&
      !payload.nodeMentions.length &&
      !!activeRequestId &&
      runningConversationId === String(conversation.id || "")
        ? payload.text.trim()
        : "";
    if (steeringText && steerLoopAgent(activeRequestId, steeringText)) {
      pushMessage({
        role: "user",
        title: "你的消息",
        content: steeringText,
        references: [...(payload.references || [])],
      }, conversation);
      return true;
    }
    if (deliveryQueue.length >= MAX_QUEUED_DELIVERIES) {
      showToast("待续任务过多，请等待当前任务结束");
      return false;
    }
    const project = store.project as Loose;
    const projectKey = getAgentProjectKey();
    const clientMessageId = uid();
    const messageText = payload.text.trim() || "请结合我选择的节点和附件继续处理。";
    const userMessageId = !resume && !options.skipUserMessage
      ? pushMessage({
          role: "user",
          title: "你的消息",
          content: messageText,
          clientMessageId,
          deliveryStage: "sent",
          references: [...(payload.references || [])],
        }, conversation)
      : undefined;
    const delivery: Delivery = {
      clientMessageId,
      payload: {
        ...payload,
        conversationId: String(conversation.id || ""),
        attachments: [...payload.attachments],
        nodeMentions: [...payload.nodeMentions],
      },
      ...(resume ? { resume } : {}),
      skipUserMessage: true,
      conversationId: String(conversation.id || ""),
      project,
      projectKey,
      ...(userMessageId ? { userMessageId } : {}),
    };
    if (options.priority) deliveryQueue.unshift(delivery);
    else deliveryQueue.push(delivery);
    notify();
    void drain();
    return true;
  }

  async function drain() {
    if (deliveryProcessing) return;
    deliveryProcessing = true;
    busy = true;
    notify();
    try {
      while (deliveryQueue.length) {
        const delivery = deliveryQueue.shift()!;
        notify();
        if (store.project !== delivery.project || getAgentProjectKey() !== delivery.projectKey) {
          if (delivery.userMessageId) {
            patchConversationMessage(delivery.conversationId, delivery.userMessageId, {
              deliveryStage: "failed",
              deliveryError: "消息所属项目已经切换",
            });
          }
          continue;
        }
        await send(delivery.payload, delivery.resume, {
          skipUserMessage: delivery.skipUserMessage,
          delivery,
        });
      }
    } finally {
      deliveryProcessing = false;
      busy = false;
      activeRequestId = "";
      runningConversationId = "";
      notify();
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    notify,
    isBusy: () => busy,
    deliver,
    cancelActiveRun: () => {
      if (!activeRequestId) return;
      void abortLoopAgent(activeRequestId).then((cancelled) => {
        if (cancelled) showToast("正在停止 Agent");
      });
    },
  };
}

/**
 * 项目里当前这一个 Agent 面板会话。
 *
 * 界面只有一个对话面板，所以会话实例只在模块级建立一次；它不是散落的运行状态变量，
 * 而是一个可以整体替换、可以为第二个面板再建一份的运行单元。
 */
export const agentSession = createAgentSession();
