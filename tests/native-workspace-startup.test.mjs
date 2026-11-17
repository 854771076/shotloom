import assert from 'node:assert/strict';
import test from 'node:test';
import { readSource } from './helpers/sourceContract.mjs';

test('embedded project starts reading while unrelated libraries are still loading', async () => {
  const source = readSource('renderer/src/app/ReactWorkbench.tsx');
  const start = source.indexOf('\n', source.indexOf('document.documentElement.lang = settingsStore.locale;'));
  const end = source.indexOf('if (cancelled) return;', start);
  const calls = [];
  let release;
  const library = new Promise(resolve => { release = resolve; });
  const names = ['loadGlobalSkills', 'loadGlobalRecipes', 'loadRecentProjects', 'initializeResourceLibraries', 'loadBoundWindowProject', 'location', 'cloudEnabled'];
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(...names, source.slice(start, end));
  const pending = run(...names.slice(0, 5).map(name => async () => { calls.push(name); if (name === 'loadBoundWindowProject' || name === 'initializeResourceLibraries') return; await library; }), { search: '?native=embedded&project=fixture' }, true);
  await new Promise(resolve => setImmediate(resolve));
  const projectStarted = calls.includes('loadBoundWindowProject');
  release();
  await pending;
  assert.ok(projectStarted, 'project read was blocked on skills, recipes and library reads');
  assert.equal(calls.filter(name => name === 'loadBoundWindowProject').length, 1);
});
