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
import { ReferenceCard } from "./ReferenceCard";
import { agentPresentation } from "./agentPresentation";
import { fileReference, nodeReference } from "./mediaReference";
import type { AgentController, AgentPanelHandle, MentionableNode } from "./contracts";
import styles from "./Composer.module.css";

const MAX_INPUT_LINES = 8;

interface ComposerProps {
  agentId: string;
  busy: boolean;
  activeConversationId: string;
  textModel: string;
  textModels: Array<{ id: string; label: string; iconId: string }>;
  controller: AgentController;
  mentionable: MentionableNode[];
  domainRevision: number;
  forwardedRef: ForwardedRef<AgentPanelHandle>;
}

export function Composer(props: ComposerProps) {
  const { agentId, busy, activeConversationId, textModel, textModels, controller } = props;
  const presentation = agentPresentation(agentId);
  const [text, setText] = useState("");
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

  function submit() {
    if (!textModels.length) return;
    const requested = text.trim();
    if (!requested && !attachments.length && !mentions.length) return;
    const prefix = skillId ? `/${skillId}` : "";
    const body =
      prefix && requested !== prefix && !requested.startsWith(`${prefix} `)
        ? `${prefix} ${requested}`
        : requested;
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
    setAttachments([]);
    setMentions([]);
    setMention(null);
    setSkillId(null);
    setMenu(null);
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
    if (event.key === "Escape") {
      if (mention) setMention(null);
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
            placeholder={busy ? "正在处理，可继续补充指令…" : presentation.placeholder}
            aria-label="给 Agent 的消息"
            onChange={(event) => {
              const value = event.target.value;
              setText(value);
              const picked = skills.find(
                (item) => value === `/${item.id}` || value.startsWith(`/${item.id} `),
              );
              setSkillId(picked?.id || null);
              trackMention(value, event.target.selectionStart ?? value.length);
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
                    setText((value) => {
                      const current = value.trimStart();
                      if (current === prefix) return "";
                      if (current.startsWith(`${prefix} `)) return current.slice(prefix.length).trimStart();
                      return value;
                    });
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
