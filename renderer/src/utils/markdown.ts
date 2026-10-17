/**
 * Agent 消息的 Markdown 渲染（纯函数，无 Vue 依赖）。
 */

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttribute(value: unknown) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

export function sanitizeUrl(value: unknown) {
  const text = String(value || '').trim();
  if (/^(https?:|mailto:)/i.test(text)) return text;
  if (/^[#/]/.test(text)) return text;
  return '';
}

export function renderInlineMarkdown(value: unknown) {
  const codeParts: string[] = [];
  let text = escapeHtml(value).replace(/`([^`]+)`/g, (_match: string, code: string) => {
    const token = ` CODE${codeParts.length} `;
    codeParts.push(`<code>${code}</code>`);
    return token;
  });
  text = text
    .replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_match: string, label: string, url: string) => {
      const safeUrl = sanitizeUrl(url);
      if (!safeUrl) return label;
      return `<a href="${escapeAttribute(safeUrl)}" target="_blank" rel="noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return codeParts.reduce((next: string, code: string, index: number) => next.replace(` CODE${index} `, code), text);
}

export function renderMarkdown(value: unknown) {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { type: string; items: string[] } | null = null;
  let codeBlock: { language: string; lines: string[] } | null = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  }

  for (const rawLine of lines) {
    const fence = rawLine.match(/^```(\w+)?\s*$/);
    if (fence) {
      if (codeBlock) {
        html.push(`<pre><code>${escapeHtml(codeBlock.lines.join('\n'))}</code></pre>`);
        codeBlock = null;
      } else {
        flushParagraph();
        flushList();
        codeBlock = { language: fence[1] || '', lines: [] };
      }
      continue;
    }
    if (codeBlock) {
      codeBlock.lines.push(rawLine);
      continue;
    }

    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = (heading[1] as string).length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? 'ul' : 'ol';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(((unordered || ordered) as RegExpMatchArray)[1] as string);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeBlock) html.push(`<pre><code>${escapeHtml(codeBlock.lines.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return html.join('');
}
