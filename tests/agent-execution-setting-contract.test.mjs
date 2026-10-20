import assert from 'node:assert/strict';

import test from 'node:test';
import { readSource } from './helpers/sourceContract.mjs';
const loopRunner = readSource('renderer/src/agent/loop/runLoopAgent.ts');
const settings = readSource('renderer/src/app/views/SettingsPanel.tsx');
const settingsStore = readSource('renderer/src/store/settingsStore.ts');
const canvasTools = readSource('renderer/src/agent/tools/canvasTools.ts');
const policy = readSource('renderer/src/agent/core/policyEngine.ts');
const composer = readSource('renderer/src/app/agent-chat/Composer.tsx');
test('Agent 节点运行能力只由用户设置和权限策略控制', () => {
  assert.match(settingsStore, /agentCanRunNodes:\s*false/);
  assert.match(loopRunner, /nodeExecution:\s*settingsStore\.agentCanRunNodes === true/);
  assert.match(canvasTools, /context\.capabilities\.nodeExecution/);
  assert.match(canvasTools, /id: 'canvas_start_generation'[\s\S]*?effect: 'media_generation'/);
  assert.match(canvasTools, /isAvailable: \(context\) => context\.capabilities\.nodeExecution && settingsStore\.agentCanRunNodes === true/);
  assert.match(policy, /projectChangingEffects\.has\(effect\)/);
  assert.match(policy, /effect === 'media_generation'[\s\S]*return 'deny'/);
  assert.doesNotMatch(canvasTools, /productionPlan\.executionMode|已通过执行计划审核|activeProductionPlanId/);
});
test('思考程度是用户设置，档位只来自模型目录声明', () => {
  assert.match(settingsStore, /agentReasoningEffort:\s*''/);
  assert.match(settingsStore, /agentReasoningEffort:\s*rawStore\.agentReasoningEffort/);
  assert.match(settingsStore, /settingsStore\.agentReasoningEffort = typeof settings\.agentReasoningEffort === 'string'/);
  assert.match(composer, /getModelReasoningEffortParam\(textModel\)/);
  assert.match(composer, /getAgentReasoningDefault\(textModel\)/, '"不选择时使用哪一档"必须读目录的同一份解析结果');
  assert.match(composer, /saveAppSettings\(\{ agentReasoningEffort: level \}\)/);
  assert.match(composer, /param\.options\.map\(String\)/, '滑轨刻度只按目录声明的档位生成');
  assert.match(composer, /role="slider"[\s\S]{0,300}aria-valuemax=\{options\.length - 1\}/, '滑轨行程与无障碍取值都来自档位数');
  assert.match(composer, /window\.addEventListener\("pointermove", move\)/, '旋钮必须能按住拖动，抬手前只更新本地预览');
  assert.doesNotMatch(composer, /setPointerCapture\(/, '指针捕获会在指针已释放时抛错，拖动监听必须挂 window');
  assert.match(composer, /onChange\(""\)/, '↺ 清空选择，回到跟随模型默认');
  assert.doesNotMatch(composer, /["']low["']\s*,\s*["']medium["']/, '界面不得自己复制一份推理档位表');
});
test('输入器只暴露用户审批偏好，不暴露内部执行模式', () => {
  // 询问/自动写的是 agentShellApproval，这是用户设置；执行计划模式属于运行时。
  assert.match(composer, /settingsStore\.agentShellApproval === "ask" \? "ask" : "full"/);
  assert.match(composer, /saveAppSettings\(\{ agentShellApproval: "(ask|full)" \}\)/);
  assert.doesNotMatch(composer, />协作<\/button>|>自主<\/button>|executionMode=\{|plan_review/);
  assert.match(settings, /允许 Agent 运行节点/);
  assert.match(settings, /可使用此技能的 Agent/);
  assert.match(settings, /skillAgentLabels/);
  assert.doesNotMatch(settings, /助手步骤确认|自动执行生成/);
});
