import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type KeyboardEvent,
} from "react";
import { IconSymbol } from "../components/IconSymbol";
import { ProviderBrandIcon } from "../components/ProviderBrandIcon";
import { desktopApi } from "../../services/desktopApi.ts";
import { saveAppSettings, settingsStore } from "../../store/settingsStore.ts";
import { nodeChatAttachmentKey } from "../../services/nodeChatAttachment.ts";
import { availableAgentSkills } from "../../agent/tools/catalogTools";
import { isImeKeyEvent } from "../canvas/imeComposition";
import { showToast } from "../../store/notificationStore";
import { useGoalPlanStore } from "../store/goalPlanStore";
import { ReferenceCard } from "./ReferenceCard";
import { GoalBar } from "./GoalBar";
import { PlanChip } from "./PlanChip";
import { agentPresentation } from "./agentPresentation";
import { fileReference, nodeReference } from "./mediaReference";
import {
  matchSlashCommands,
  parseSlashCommand,
  type SlashCommandItem,
} from "./slashCommands";
import type { AgentController, AgentGoalView, AgentPanelHandle, MentionableNode } from "./contracts";
import styles from "./Composer.module.css";

type PaletteEntry =
  | { kind: "command"; key: string; item: SlashCommandItem }
  | { kind: "skill"; key: string; item: { id: string; name?: string | undefined } };

const MAX_INPUT_LINES = 8;

interface ComposerProps {
  agentId: string;
  busy: boolean;
  activeConversationId: string;
  textModel: string;
  textModels: Array<{ id: string; label: string; iconId: string }>;
  /** 项目级长期目标与计划模式：面板只读这一份，改写一律走 controller 的 CAS 动词。 */
  goal: AgentGoalView | null;
  planMode: boolean;
  goalArmed: boolean;
  controller: AgentController;
  mentionable: MentionableNode[];
  domainRevision: number;
  forwardedRef: ForwardedRef<AgentPanelHandle>;
}

export function Composer(props: ComposerProps) {
  const { agentId, busy, activeConversationId, textModel, textModels, goal, planMode, goalArmed, controller } = props;
  const presentation = agentPresentation(agentId);
  // 输入草稿与 '/' 候选面板是纯界面态，落在按面板分片的 zustand store 上；goal/plan 的真实状态
  // 永远保存在 store.project，本组件不在这里写它们。画布/剪辑/文本三个面板可能同时挂载，草稿绝不能跨面板串。
  const panelKey = `${agentId}:${activeConversationId}`;
  const text = useGoalPlanStore((s) => s.panels[panelKey]?.draft ?? "");
  const slash = useGoalPlanStore((s) => s.panels[panelKey]?.slash ?? null);
  const writeDraft = useGoalPlanStore((s) => s.setDraft);
  const writeSlash = useGoalPlanStore((s) => s.setSlash);
  const setText = useCallback((value: string) => writeDraft(panelKey, value), [writeDraft, panelKey]);
  const setSlash = useCallback(
    (next: { query: string; index: number } | null) => writeSlash(panelKey, next),
    [writeSlash, panelKey],
  );
  const [attachments, setAttachments] = useState<Record<string, unknown>[]>([]);
  const [mentions, setMentions] = useState<MentionableNode[]>([]);
  const [mention, setMention] = useState<{ query: string; start: number; index: number } | null>(null);
  const [menu, setMenu] = useState<Selector | null>(null);
  const [skillId, setSkillId] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const seatRef = useRef<HTMLDivElement | null>(null);
  const autoSkill = useRef(false);

  // 选择器与运行时都调用 availableAgentSkills，界面不再自己拼可见性解析参数。
  const skills = useMemo(
    () => availableAgentSkills(agentId),
    [props.domainRevision, agentId],
  );
  const skill = useMemo(() => skills.find((item) => item.id === skillId) || null, [skills, skillId]);

  // '/' 候选：命令（goal/plan）永远排在技能前面，让用户先看到工作流开关，再看到技能。
  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    if (!slash) return [];
    const query = slash.query.toLowerCase();
    const commands: PaletteEntry[] = matchSlashCommands(slash.query).map((item) => ({
      kind: "command",
      key: `command:${item.id}`,
      item,
    }));
    const skillItems: PaletteEntry[] = skills
      .filter((item) => !query || `${item.id} ${item.name || ""}`.toLowerCase().includes(query))
      .slice(0, 8)
      .map((item) => ({ kind: "skill", key: `skill:${item.id}`, item: { id: item.id, name: item.name } }));
    return [...commands, ...skillItems];
  }, [slash, skills]);

  useEffect(() => {
    // 当前 Agent 只有一个可选 Skill 时默认选中它，用户仍可手动改选。
    const only = skills.length === 1 ? skills[0] : null;
    if (!only) {
      autoSkill.current = false;
      return;
    }
    if (!autoSkill.current) {
      autoSkill.current = true;
      setSkillId(only.id);
    }
  }, [skills]);

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => textarea.current?.focus());
  }, []);

  const attachNodeImage = useCallback((node: MentionableNode) => {
    const attachment = node.imageAttachment;
    if (!attachment) return;
    const key = nodeChatAttachmentKey(attachment);
    setAttachments((items) =>
      key && items.some((item) => nodeChatAttachmentKey(item) === key)
        ? items
        : [...items, { ...attachment }],
    );
  }, []);

  const addMention = useCallback(
    (node: MentionableNode) => {
      setMentions((items) => (items.some((item) => item.id === node.id) ? items : [...items, node]));
      attachNodeImage(node);
    },
    [attachNodeImage],
  );

  const addNodeMentionById = useCallback(
    (nodeId: string) => {
      const found = props.mentionable.find((node) => node.id === nodeId);
      if (!found) return;
      addMention(found);
      focusInput();
    },
    [addMention, focusInput, props.mentionable],
  );

  useImperativeHandle(props.forwardedRef, () => ({ addNodeMentionById }), [addNodeMentionById]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!seatRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menu]);

  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return props.mentionable
      .filter(
        (node) =>
          !mentions.some((item) => item.id === node.id) &&
          (!query || [node.alias, node.title, node.typeLabel].join(" ").toLowerCase().includes(query)),
      )
      .slice(0, 8);
  }, [mention, mentions, props.mentionable]);

  const visibleAttachments = attachments.filter(
    (item) => !mentions.some((node) => node.id === item.nodeId),
  );

  // 引用轨道和发出去的消息共用同一份描述，用户发出前后看到的必须是同一个素材。
  const references = [
    ...mentions.map((node) => ({
      key: `node:${node.id}`,
      reference: nodeReference(node.node),
      onRemove: () => {
        setMentions((items) => items.filter((item) => item.id !== node.id));
        setAttachments((items) => items.filter((item) => item.nodeId !== node.id));
      },
    })),
    ...visibleAttachments.map((file) => ({
      key: `file:${String(file.name || file.fileName || "")}:${String(file.path || file.filePath || "")}`,
      reference: fileReference(file),
      onRemove: () => setAttachments((items) => items.filter((item) => item !== file)),
    })),
  ];

  function resize() {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_INPUT_LINES * 24)}px`;
  }
  useEffect(resize, [text]);

  function trackMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const match = before.match(/(^|\s)@([^\s@]*)$/);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[2] ?? "";
    setMention({ query, start: before.length - query.length - 1, index: 0 });
  }

  function insertMention(node: MentionableNode) {
    const element = textarea.current;
    const caret = element?.selectionStart ?? text.length;
    const start = mention ? mention.start : caret;
    setText(`${text.slice(0, start)}${text.slice(caret).replace(/^[^\s@]*/, "")}`);
    addMention(node);
    setMention(null);
    focusInput();
  }

  // 菜单只在整段输入是一个 `/token`（尚未输入空格）时出现；一旦补上空格或选中技能就收起。
  function trackSlash(value: string) {
    const match = value.match(/^\/([^\s]*)$/);
    if (!match) {
      setSlash(null);
      return;
    }
    setSlash({ query: match[1] ?? "", index: 0 });
  }

  function selectPaletteEntry(entry: PaletteEntry) {
    // 选中候选只把词填入输入框：命令的参数由用户补全后再回车执行，技能沿用 `/id ` 前缀。
    if (entry.kind === "command") {
      setText(`/${entry.item.id} `);
    } else {
      setSkillId(entry.item.id);
      setText(`/${entry.item.id} `);
    }
    setSlash(null);
    setMention(null);
    focusInput();
  }

  async function pickFile() {
    const file = await desktopApi.file.pickResource?.();
    if (!file) return;
    const key = file.path || file.filePath || file.name || file.fileName;
    setAttachments((items) =>
      items.some((item) => (item.path || item.filePath || item.name || item.fileName) === key)
        ? items
        : [...items, file],
    );
  }

  function sendToRuntime(body: string) {
    if (!textModels.length) return;
    const accepted = controller.send({
      text: body,
      model: textModel,
      attachments: attachments.map((item) => ({ ...item })),
      nodeMentions: mentions.map(({ imageAttachment: _drop, node: _node, ...item }) => ({ ...item })),
      // 引用卡只随消息持久化供界面回看，不进模型请求。
      references: references.map((item) => item.reference),
      // 必须落在面板当前显示的会话上，不能靠项目级 active 指针二次解析。
      conversationId: activeConversationId,
    });
    if (!accepted) return;
    setText("");
    setSlash(null);
    setAttachments([]);
    setMentions([]);
    setMention(null);
    setSkillId(null);
    setMenu(null);
  }

  function submit() {
    if (!textModels.length) return;
    const requested = text.trim();
    // 命令优先于一切：/goal 创建或恢复目标会启动续行，/plan <正文> 会发送本轮请求。
    if (requested.startsWith("/")) {
      const command = parseSlashCommand(requested);
      if (command) {
        // goal 状态变更随时可执行；plan 开关与本轮请求必须等当前运行结束，否则会打断正在跑的回合。
        if (controller.isCommandRunBusy(command)) {
          showToast("请等待当前任务结束后再切换计划模式");
          return;
        }
        const { deliverText, error } = controller.runCommand(command, { conversationId: activeConversationId, model: textModel });
        setText("");
        setSlash(null);
        setMention(null);
        setMenu(null);
        // 状态变更成功不再往会话里回显：目标条与计划徽标才是它们的可见处。
        if (error) showToast(error);
        // 唯一例外：/plan <正文> 进入计划模式后，把正文当作本轮真实请求照常发出。
        if (deliverText) sendToRuntime(deliverText);
        return;
      }
    }
    if (!requested && !attachments.length && !mentions.length) return;
    const prefix = skillId ? `/${skillId}` : "";
    const body =
      prefix && requested !== prefix && !requested.startsWith(`${prefix} `)
        ? `${prefix} ${requested}`
        : requested;
    sendToRuntime(body);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (mention && mentionOptions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setMention((current) =>
        current
          ? { ...current, index: (current.index + step + mentionOptions.length) % mentionOptions.length }
          : current,
      );
      return;
    }
    if (mention && event.key === "Enter") {
      const target = mentionOptions[mention.index];
      if (target) {
        event.preventDefault();
        insertMention(target);
        return;
      }
    }
    if (slash && paletteEntries.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const len = paletteEntries.length;
      setSlash({ query: slash.query, index: (slash.index + step + len) % len });
      return;
    }
    // 命令已完整输入（/goal、/plan、/goal pause…）时交给回车执行；只有在挑选候选词时才用回车选中。
    if (
      slash &&
      paletteEntries.length &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !parseSlashCommand(text.trim())
    ) {
      const target = paletteEntries[Math.min(slash.index, paletteEntries.length - 1)];
      if (target) {
        event.preventDefault();
        selectPaletteEntry(target);
        return;
      }
    }
    if (event.key === "Escape") {
      if (mention) setMention(null);
      else if (slash) setSlash(null);
      else if (menu) setMenu(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const disabled = !textModels.length;
  const activeModel = textModels.find((item) => item.id === textModel);
  const shellMode = settingsStore.agentShellApproval === "ask" ? "ask" : "full";
  // 计划模式改变的是"这一轮该写什么"，输入提示跟着换，用户才知道接下来是拿方案而不是拿成片。
  const placeholder = planMode
    ? "描述本轮任务：Agent 会先只做调研并产出计划，待你确认后再执行"
    : busy
      ? "正在处理，可继续补充指令…"
      : presentation.placeholder;

  return (
    <div className={styles.seat} ref={seatRef}>
      {disabled && (
        <div className={styles.warning}>
          <IconSymbol name="warning" />
          <span>
            <strong>还未配置文本模型</strong>
            <small>前往“设置 → API 厂商”完成配置后即可开始创作</small>
          </span>
        </div>
      )}
      <GoalBar
        goal={goal}
        armed={goalArmed}
        busy={busy}
        conversationId={activeConversationId}
        model={textModel}
        controller={controller}
      />
      <div className={styles.card} data-menu={menu || undefined} data-disabled={disabled || undefined}>
        {!!references.length && (
          <div className={styles.rail}>
            {references.map((item) => (
              <ReferenceCard
                key={item.key}
                reference={item.reference}
                onRemove={item.onRemove}
              />
            ))}
          </div>
        )}

        <div className={styles.inputSeat}>
          <textarea
            ref={textarea}
            className={styles.input}
            value={text}
            rows={1}
            disabled={disabled}
            spellCheck={false}
            placeholder={placeholder}
            aria-label="给 Agent 的消息"
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              const picked = skills.find(
                (item) => value === `/${item.id}` || value.startsWith(`/${item.id} `),
              );
              setSkillId(picked?.id || null);
              trackMention(value, event.target.selectionStart ?? value.length);
              trackSlash(value);
            }}
            onKeyDown={onKeyDown}
          />
          {mention && mentionOptions.length > 0 && (
            <div className={styles.mentionMenu} role="listbox">
              {mentionOptions.map((node, index) => (
                <button
                  key={node.id}
                  type="button"
                  role="option"
                  aria-selected={index === mention.index}
                  data-active={index === mention.index || undefined}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    insertMention(node);
                  }}
                >
                  <strong title={node.title}>{node.title}</strong>
                  <span>@{node.alias}</span>
                  <em>{node.typeLabel}</em>
                </button>
              ))}
            </div>
          )}
          {slash && paletteEntries.length > 0 && (
            <div className={styles.mentionMenu} role="listbox" aria-label="选择命令或技能">
              {paletteEntries.map((entry, index) => (
                <button
                  key={entry.key}
                  type="button"
                  role="option"
                  aria-selected={index === slash.index}
                  data-active={index === slash.index || undefined}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    selectPaletteEntry(entry);
                  }}
                >
                  <strong>{entry.kind === "command" ? entry.item.name : entry.item.name || entry.item.id}</strong>
                  <span>{entry.kind === "command" ? entry.item.usage : `/${entry.item.id}`}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.toolbar}>
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.add}
              title="添加文件"
              aria-label="添加文件"
              disabled={disabled}
              onClick={() => void pickFile()}
            >
              <IconSymbol name="plus" />
            </button>
            <SelectorChip
              open={menu === "skill"}
              label={skill ? skill.name || skill.id : presentation.skillLabel}
              hint={
                skill
                  ? `已选择：${skill.name || skill.id}`
                  : "Agent 根据任务自动选择技能，可在这里指定"
              }
              icon="puzzle"
              active={Boolean(skill)}
              disabled={disabled}
              onToggle={() => setMenu(menu === "skill" ? null : "skill")}
            >
              <MenuRow
                selected={!skill}
                title="交给 Agent 选择"
                subtitle="根据任务按需使用技能"
                onClick={() => {
                  if (skillId) {
                    const prefix = `/${skillId}`;
                    const current = text.trimStart();
                    const next = current === prefix
                      ? ""
                      : current.startsWith(`${prefix} `)
                        ? current.slice(prefix.length).trimStart()
                        : text;
                    setText(next);
                  }
                  setSkillId(null);
                  setMenu(null);
                  focusInput();
                }}
              />
              {skills.map((item) => (
                <MenuRow
                  key={item.id}
                  selected={skill?.id === item.id}
                  title={item.name || item.id}
                  subtitle={`/${item.id}`}
                  onClick={() => {
                    const current = text.trimStart();
                    const previous = skillId ? `/${skillId}` : "";
                    const stripped =
                      previous && current === previous
                        ? ""
                        : previous && current.startsWith(`${previous} `)
                          ? current.slice(previous.length).trimStart()
                          : current;
                    setText(stripped ? `/${item.id} ${stripped}` : `/${item.id} `);
                    setSkillId(item.id);
                    setMention(null);
                    setMenu(null);
                    focusInput();
                  }}
                />
              ))}
            </SelectorChip>

            <SelectorChip
              open={menu === "model"}
              label={activeModel?.label || "模型"}
              hint={activeModel?.label || "选择模型"}
              leading={
                <span className={styles.brand}>
                  <ProviderBrandIcon icon={activeModel?.iconId || "custom"} />
                </span>
              }
              disabled={disabled}
              onToggle={() => setMenu(menu === "model" ? null : "model")}
            >
              {textModels.map((item) => (
                <MenuRow
                  key={item.id}
                  selected={item.id === textModel}
                  title={item.label}
                  subtitle={item.id}
                  leading={
                    <span className={styles.brand}>
                      <ProviderBrandIcon icon={item.iconId} />
                    </span>
                  }
                  onClick={() => {
                    controller.changeModel(item.id);
                    setMenu(null);
                  }}
                />
              ))}
            </SelectorChip>

            <SelectorChip
              open={menu === "mode"}
              label={shellMode === "ask" ? "询问" : "自动"}
              hint="Agent 模式"
              icon={shellMode === "ask" ? "hand" : "shield"}
              tone={shellMode === "full" ? "accent" : undefined}
              disabled={disabled}
              onToggle={() => setMenu(menu === "mode" ? null : "mode")}
            >
              <MenuRow
                selected={shellMode === "ask"}
                title="询问"
                subtitle="执行生成等关键操作前，先询问你。"
                icon="hand"
                onClick={() => {
                  void saveAppSettings({ agentShellApproval: "ask" });
                  setMenu(null);
                }}
              />
              <MenuRow
                selected={shellMode === "full"}
                title="自动"
                subtitle="自动完成生成等操作，减少中途打断。"
                icon="shield"
                onClick={() => {
                  void saveAppSettings({ agentShellApproval: "full" });
                  setMenu(null);
                }}
              />
            </SelectorChip>

            <PlanChip
              active={planMode}
              busy={busy}
              conversationId={activeConversationId}
              model={textModel}
              controller={controller}
            />
          </div>

          {busy && (
            <button
              type="button"
              className={styles.stop}
              title="停止 Agent"
              aria-label="停止 Agent"
              onClick={controller.cancel}
            >
              <IconSymbol name="stop" />
            </button>
          )}
          <button
            type="button"
            className={styles.send}
            disabled={disabled}
            title="发送（Enter）"
            aria-label="发送"
            onClick={submit}
          >
            <IconSymbol name="arrow-up" />
          </button>
        </div>
      </div>
    </div>
  );
}

type Selector = "skill" | "model" | "mode";

function SelectorChip({
  open,
  label,
  hint,
  icon,
  leading,
  active,
  tone,
  disabled,
  onToggle,
  children,
}: {
  open: boolean;
  label: string;
  hint: string;
  icon?: string;
  leading?: React.ReactNode;
  active?: boolean;
  tone?: "accent" | undefined;
  disabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.selector} data-open={open || undefined}>
      <button
        type="button"
        className={styles.chip}
        data-active={active || tone === "accent" || undefined}
        title={hint}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={onToggle}
      >
        {leading}
        {icon && !leading && <IconSymbol name={icon} />}
        <span className={styles.chipLabel}>{label}</span>
        <IconSymbol name="chevron-down" className={styles.chipChevron} />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  selected,
  title,
  subtitle,
  icon,
  leading,
  onClick,
}: {
  selected: boolean;
  title: string;
  subtitle?: string;
  icon?: string;
  leading?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={selected} data-selected={selected || undefined} onClick={onClick}>
      {leading}
      {icon && !leading && <IconSymbol name={icon} className={styles.menuIcon} />}
      <span className={styles.menuCopy}>
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
      {selected && <IconSymbol name="check" className={styles.menuCheck} />}
    </button>
  );
}
