import assert from 'node:assert/strict';
import test from 'node:test';
import { collectWorkspacePreloads } from '../src/lib/workspacePreload';

test('workspace warming follows static build dependencies without loading optional editors or remote URLs', () => {
  const chunks = {
    'index.html': { file: 'assets/main-123.js', imports: ['react'], css: ['assets/main-123.css'] },
    '_ReactWorkbench-123.js': { name: 'ReactWorkbench', file: 'assets/workbench-123.js', imports: ['react', 'project', 'invalid'], dynamicImports: ['editor'] },
    'src/app/ui/antd/AntdProvider.tsx': { name: 'AntdProvider', file: 'assets/provider-123.js', imports: ['react'] },
    react: { file: 'assets/react-123.js' }, project: { file: 'assets/project-123.js', imports: ['react', 'project'] },
    invalid: { file: 'https://other.example/code.js' }, editor: { file: 'assets/editor-123.js' },
  };
  const files = collectWorkspacePreloads(chunks);
  assert.deepEqual(files, ['assets/main-123.js', 'assets/main-123.css', 'assets/react-123.js', 'assets/workbench-123.js', 'assets/project-123.js', 'assets/provider-123.js']);
  assert.deepEqual(collectWorkspacePreloads({}), []);
});
