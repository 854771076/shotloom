import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const repoRoot = new URL('../../', import.meta.url);
const sources = new Map();

function toRepoPath(relativePath) {
  return relativePath.replace(/^\.\//, '').replace(/^\.\.\//, '');
}

/**
 * 读取一份产品源码用于契约断言，路径相对仓库根，例如
 * `renderer/src/app/ReactWorkbench.tsx` 或 `src-tauri/src/commands/file.rs`。
 *
 * 测试自己不再各写一份 `readFileSync(new URL('../…'))`：同一个文件会被十几个测试读，
 * 统一在这里缓存一次，路径基准也只有一个，测试可以从任何工作目录运行。
 */
export function readSource(relativePath) {
  const key = toRepoPath(relativePath);
  if (!sources.has(key)) sources.set(key, readFileSync(new URL(key, repoRoot), 'utf8'));
  return sources.get(key);
}

/**
 * 把一个契约拆在多个模块里的情况读成一份文本，避免同一条断言复制进每个文件各自的测试。
 */
export function readSources(relativePaths) {
  return relativePaths.map((relativePath) => readSource(relativePath)).join('\n');
}

/**
 * 源码文本断言失败时，报错只该指出"哪个文件没有满足哪条契约"，
 * 而不是把几百行源码倒进测试输出里。
 */
export function assertSource(relativePath, source, pattern, shouldMatch, message) {
  const label = `${relativePath}${message ? ` — ${message}` : ''}`;
  if (shouldMatch) assert.match(source, pattern, label);
  else assert.doesNotMatch(source, pattern, label);
}

/** 断言「这个文件在不在」也按仓库根路径来问，测试不自己拼 URL。 */
export function sourceExists(relativePath) {
  return existsSync(new URL(toRepoPath(relativePath), repoRoot));
}
