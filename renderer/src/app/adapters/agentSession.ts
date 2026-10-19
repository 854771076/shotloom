import { abortLoopAgent, runLoopAgent, steerLoopAgent } from "../../agent/loop/runLoopAgent";
import { getAgentProjectKey } from "../../services/agentProjectIdentity";
import { getActiveAgentConversation, readGoal, takeGoalRound, titleConversationFromMessage, type AgentGoal } from "../../services/agentConversations.ts";
import { recordPerformanceMetric } from "../../services/performanceMetrics";
import { toRaw } from "../../store/domainReactivity.ts";
import { showToast } from "../../store/notificationStore";
import { flushProjectCheckpoint, store, touchProject } from "../../store/projectStore";
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
/**
 * 一次自动续行的预约身份。它在续行指令进入投递队列时建立，真正派发前必须逐项复核：
 * 目标仍是同一 id/revision 的 active 目标、轮次仍等于 roundsStarted+1、且没有被更新的
 * 排队消息顶掉（stale）。任何一项不满足就不派发，绝不把一轮"其实不该跑"的续行发出去。
 */
type GoalRoundAttempt = {
  goalId: string;
  revision: number;
  round: number;
  stale: boolean;
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
  goalRound?: GoalRoundAttempt;
};
type DeliverOptions = { skipUserMessage?: boolean; priority?: boolean; goalRound?: GoalRoundAttempt };

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
 * 自动续行每一轮发给模型的指令：只重申当前目标与轮次进度，并把"是否已经达成或受阻"的判断
 * 交回模型——它必须用真实只读工具核验后再 complete/blocked，应用代码不替它宣布完成。
 */
function goalRoundInstruction(goal: AgentGoal): string {
  return [
    `继续朝当前长期目标推进（第 ${goal.roundsStarted}/${goal.maxGoalRounds} 轮）：${goal.objective}`,
    '先用只读工具核验当前画布、任务与产出的真实状态，再从未完成的部分接着做，不要重复已经成功的操作。',
    '目标真正达成时调用 update_goal 的 complete 收尾；确实无法继续时调用 blocked 并如实写明原因；还需要更多轮次就继续推进。不要虚报完成。',
  ].join('\n');
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
  /** 从空闲状态启动刚创建或恢复的目标的第一轮。 */
  startGoal: (model: string, conversationId: string) => void;
  /** 自动续行当前是否处于武装态：目标条据此区分"进行中"与"已暂停（用户已停止）"。 */
  isGoalDriverArmed: () => boolean;
  /** 投递一条消息：运行中的纯文本指令注入当前这一轮，其余按到达顺序排队。 */
  deliver: (payload: AgentSendPayload, resume?: AgentResume, options?: DeliverOptions) => boolean;
  /** 追加一条本地结果消息：命令的确认只呈现结果，不发起模型请求。 */
  pushLocalMessage: (text: string, conversationId?: string) => void;
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
  // 目标自动续行是进程本地的运行决策，不进持久 goal：只要当前项目有进行中目标，
  // 一轮真实运行结束后就据此接着开下一轮；用户停止、运行失败、目标转为非 active
  // 或轮次达上限都会立刻停用，绝不把一次未验证的链式运行固化下来。
  let goalDriverArmed = false;
  let goalRoundConversationId = "";
  let goalRoundModel = "";
  // 当前已排队、尚未派发（或已作废）的续行预约。它是进程本地的运行决策，不进持久 goal。
  let goalRoundAttempt: GoalRoundAttempt | null = null;

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
      // 一轮真实运行干净结束、且项目仍有进行中目标时，武装自动续行并记住归属会话与模型。
      // 停用只发生在失败、停止、目标转为非 active 或轮次达上限——不在这里凭空造出目标。
      const finishedGoal = readGoal(store.project as Loose);
      if (finishedGoal && finishedGoal.phase === "active") {
        goalDriverArmed = true;
        goalRoundConversationId = String(conversation.id || "");
        goalRoundModel = payload.model;
      }
    } catch (cause: any) {
      goalDriverArmed = false;
      goalRoundAttempt = null;
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
    // 有别的消息插到自动续行前面时，把尚未派发的续行预约标 stale：drain 复核不过就不会派发它，
    // 避免用户消息和一轮续行抢同一段运行。续行自己的投递不算 competing。
    if (!options.goalRound && goalRoundAttempt && !goalRoundAttempt.stale) {
      goalRoundAttempt.stale = true;
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
      ...(options.goalRound ? { goalRound: options.goalRound } : {}),
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
      while (true) {
        if (deliveryQueue.length) {
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
          // 续行投递派发前必须复核预约；复核不过就整轮跳过，绝不把一个不该跑的续行发出去。
          if (delivery.goalRound && !(await admitGoalRound(delivery.goalRound))) continue;
          await send(delivery.payload, delivery.resume, {
            skipUserMessage: delivery.skipUserMessage,
            delivery,
          });
          continue;
        }
        // 队列已空：若项目仍有进行中目标就据实推进下一轮自动续行，否则结束本次 drain。
        if (!(await scheduleGoalRound())) break;
      }
    } finally {
      deliveryProcessing = false;
      busy = false;
      activeRequestId = "";
      runningConversationId = "";
      notify();
    }
  }

  function goalRoundTarget(): Loose {
    return conversationById(goalRoundConversationId) || (toRaw(activeConversation()) as Loose);
  }

  /**
   * 队列清空后的自动续行决策：武装态 + 进行中目标 + 未达轮次上限 + 没有 competing 排队消息，
   * 才为下一轮建立预约并把续行指令排进队列。真正的持久轮次推进（takeGoalRound）与
   * checkpoint-before-drive 都在派发前（admitGoalRound）完成，保证"已消耗的轮次"先落盘、
   * 且复核不过的预约不会白白消耗轮次。
   */
  async function scheduleGoalRound(): Promise<boolean> {
    if (!goalDriverArmed) return false;
    const project = store.project;
    const projectKey = getAgentProjectKey();
    const goal = readGoal(store.project as Loose);
    if (!goal || goal.phase !== "active") {
      goalDriverArmed = false;
      return false;
    }
    if (goal.roundsStarted >= goal.maxGoalRounds) {
      goalDriverArmed = false;
      pushMessage({
        role: "assistant",
        notice: "status",
        content: `自动续行已达轮次上限（${goal.roundsStarted}/${goal.maxGoalRounds}）。发送新指令可继续，或用 /goal 调整上限后 /goal resume。`,
      }, goalRoundTarget());
      touchProject({ sessionDelay: 250, coalesceSession: true });
      return false;
    }
    // competing-queued：已经有别的消息在排队，就把它让给排队消息，本轮不预约。
    if (deliveryQueue.length) return false;
    const reservation: GoalRoundAttempt = {
      goalId: goal.id,
      revision: goal.revision,
      round: goal.roundsStarted + 1,
      stale: false,
    };
    // checkpoint-before-drive：先把当前已持久化的轮次压实落盘，再预约下一轮；
    // 落盘失败就收手，不假装成功。
    if (!(await flushProjectCheckpoint())) {
      goalDriverArmed = false;
      pushMessage({
        role: "assistant",
        notice: "status",
        content: "目标续行前的持久化检查失败，已停止自动续行；请检查项目保存位置后重试。",
      }, goalRoundTarget());
      return false;
    }
    // 落盘期间可能有新消息排队、目标被改或项目被切换：逐项复核，过不了就不预约。
    if (!goalDriverArmed) return false;
    if (store.project !== project || getAgentProjectKey() !== projectKey) {
      goalDriverArmed = false;
      return false;
    }
    if (deliveryQueue.length) return false;
    const latest = readGoal(store.project as Loose);
    if (!latest || latest.phase !== "active") {
      goalDriverArmed = false;
      return false;
    }
    if (latest.id !== reservation.goalId || latest.revision !== reservation.revision) return false;
    goalRoundAttempt = reservation;
    const delivered = deliver(
      {
        text: goalRoundInstruction({ ...goal, roundsStarted: reservation.round }),
        model: goalRoundModel,
        attachments: [],
        nodeMentions: [],
        conversationId: goalRoundConversationId,
      },
      undefined,
      { skipUserMessage: true, goalRound: reservation },
    );
    if (!delivered) {
      goalRoundAttempt = null;
      goalDriverArmed = false;
    }
    return delivered;
  }

  /**
   * 派发一条续行投递前的预约复核与持久推进：预约必须仍是当前这次（未被 stale）、目标仍是同一
   * id/revision 的 active 目标、且轮次仍等于 roundsStarted+1。复核通过才 takeGoalRound（唯一落盘点）
   * 并 checkpoint-before-drive；任一环节不成立就返回 false，调用方跳过这一跳。
   */
  async function admitGoalRound(reservation: GoalRoundAttempt): Promise<boolean> {
    const project = store.project;
    const projectKey = getAgentProjectKey();
    const goal = readGoal(store.project as Loose);
    const valid = goalRoundAttempt === reservation
      && !reservation.stale
      && !!goal && goal.phase === "active"
      && goal.id === reservation.goalId
      && goal.revision === reservation.revision
      && reservation.round === goal.roundsStarted + 1;
    if (!valid) {
      goalRoundAttempt = null;
      if (!goal || goal.phase !== "active") goalDriverArmed = false;
      return false;
    }
    const taken = takeGoalRound(store.project as Loose);
    if (!taken.continued) {
      goalRoundAttempt = null;
      goalDriverArmed = false;
      if (taken.reason === "round-limit") {
        pushMessage({
          role: "assistant",
          notice: "status",
          content: `自动续行已达轮次上限（${goal.roundsStarted}/${goal.maxGoalRounds}）。发送新指令可继续，或用 /goal 调整上限后 /goal resume。`,
        }, goalRoundTarget());
        touchProject({ sessionDelay: 250, coalesceSession: true });
      }
      return false;
    }
    // 轮次边界是一行分隔提示，不是助手正文：只有真正派发出去的这一轮才留下边界，
    // 被复核作废的预约不会在历史里凭空多出一轮。
    pushMessage({
      role: "assistant",
      notice: "divider",
      content: `目标续行 · 第 ${reservation.round} 轮`,
    }, goalRoundTarget());
    touchProject({ sessionDelay: 250, coalesceSession: true });
    // checkpoint-before-drive：已消耗的这一轮必须先于模型回合落盘，崩溃不会让轮次回退。
    if (!(await flushProjectCheckpoint())) {
      goalRoundAttempt = null;
      goalDriverArmed = false;
      pushMessage({
        role: "assistant",
        notice: "status",
        content: "目标轮次已消耗，但持久化失败，已停止自动续行以避免崩溃后状态不一致。",
      }, goalRoundTarget());
      return false;
    }
    goalRoundAttempt = null;
    const latest = readGoal(store.project as Loose);
    if (!goalDriverArmed || store.project !== project || getAgentProjectKey() !== projectKey
      || !latest || latest.phase !== "active" || latest.id !== taken.goal.id
      || latest.revision !== taken.goal.revision) {
      goalDriverArmed = false;
      return false;
    }
    return true;
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
    notify,
    isBusy: () => busy,
    isGoalDriverArmed: () => goalDriverArmed,
    startGoal: (model, conversationId) => {
      if (busy) return;
      goalRoundModel = model;
      goalRoundConversationId = conversationId;
      goalDriverArmed = true;
      void drain();
    },
    deliver,
    pushLocalMessage: (text, conversationId) => {
      const conversation = conversationById(String(conversationId || "")) || undefined;
      pushMessage({ role: "assistant", title: "命令", content: text }, conversation);
    },
    cancelActiveRun: () => {
      // 先停用自动续行：即便此刻正处在两轮之间（没有 activeRequestId），用户按下停止
      // 也必须终结这条链，而不是等下一轮又被武装起来。
      goalDriverArmed = false;
      goalRoundAttempt = null;
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
