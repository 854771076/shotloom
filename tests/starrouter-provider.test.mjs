import { loadModelCatalog } from './helpers/modelCatalog.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { optionLabel } from '../renderer/src/utils/modelPresentation.ts';
import { readSource } from './helpers/sourceContract.mjs';

const adaptersIndexSource = readSource('renderer/src/domain/provider/adapters/index.ts');
const adapterSource = (name) => readSource(`../renderer/src/domain/provider/adapters/${name}.ts`);
const catalogSource = readSource('renderer/src/domain/catalog/ModelCatalog.ts');
const loopRequestSource = readSource('renderer/src/agent/loop/modelRequest.ts');
const catalogJson = loadModelCatalog();
const starrouterAdapter = adapterSource('starrouter');

test('StarRouter 适配器声明官方地址并在注册表中唯一登记', () => {
  assert.match(starrouterAdapter, /id: 'starrouter'/);
  assert.match(starrouterAdapter, /baseUrl: 'https:\/\/starrouter\.io\/v1'/);
  assert.match(adaptersIndexSource, /import \{ starrouterAdapter \} from '\.\/starrouter'/);
  assert.equal(
    [...adaptersIndexSource.matchAll(/starrouterAdapter/g)].length,
    2,
    'StarRouter 只能在 import 与登记数组中各出现一次',
  );
});

test('未登记的厂商没有适配器可执行', () => {
  assert.match(
    adaptersIndexSource,
    /没有内置厂商适配器[\s\S]*domain\/provider\/adapters/,
  );
});

test('画布和 Agent 请求均使用目录声明的上游模型 ID', () => {
  assert.match(catalogSource, /upstreamModel: model\.upstreamModel \|\| model\.id/);
  assert.match(adapterSource('declarative'), /model: contract\.upstreamModel/);
  assert.match(loopRequestSource, /upstreamModel: info\.upstreamModel/);
});

test('StarRouter 内置目录覆盖文本、图片、视频和音频生成', () => {
  const models = catalogJson.models.filter((model) => model.provider === 'starrouter');
  const byType = Object.groupBy(models, (model) => model.type);
  assert.equal(byType.textGeneration.length, 8);
  assert.equal(byType.imageGeneration.length, 5);
  assert.equal(byType.videoGeneration.length, 6);
  assert.equal(byType.audioGeneration.length, 2);

  const openAiVideoModels = byType.videoGeneration.filter((model) => model.upstreamModel.startsWith('grok-imagine-video'));
  for (const model of openAiVideoModels) {
    const mode = model.modes[0];
    assert.equal(mode.endpoint.path, '/videos');
    assert.equal(mode.taskEndpoint.path, '/videos/{taskId}');
    assert.equal(mode.requestTemplate.input_reference, '{{imageInputReference}}');
    assert.equal(mode.resultEndpoint.path, '/videos/{taskId}/content');
    assert.equal(mode.resultDownloadAuth, true);
  }
  for (const model of byType.audioGeneration) {
    const mode = model.modes[0];
    assert.equal(mode.endpoint.path, '/audio/speech');
    // StarRouter 把 OpenAI 风格的 response_format 原样映射成 MiniMax 的 output_format，
    // `mp3` 会被上游判 2013 invalid params；只有 hex/url 合法，且 hex 由网关解码后
    // 仍以二进制 audio/mpeg 返回，所以请求发 output_format=hex、结果按二进制解析。
    assert.equal(mode.requestTemplate.output_format, 'hex');
    assert.equal(mode.requestTemplate.response_format, undefined);
    assert.deepEqual(mode.resultBody, {
      encoding: 'binary', mimeType: 'audio/mpeg', fileExtension: 'mp3',
    });
  }
});

test('StarRouter GPT 5.5 使用官方上下文、输出长度和推理强度', () => {
  const model = catalogJson.models.find((candidate) => candidate.id === 'starrouter-gpt-5.5');
  const mode = model.modes[0];

  assert.equal(model.upstreamModel, 'gpt-5.5');
  assert.equal(mode.endpoint.path, '/chat/completions');
  assert.equal(mode.inputConstraints.text.maxTokens, 1_050_000);
  assert.equal(mode.outputConstraints.maxTokens, 128_000);
  const reasoningEffort = mode.params.find((param) => param.key === 'reasoningEffort');
  assert.deepEqual(reasoningEffort.options, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(reasoningEffort.options.map((value) => optionLabel(reasoningEffort, value)),
    ['关闭', '低', '中', '高', '极高']);
  assert.equal(mode.requestTemplate.reasoning_effort, '{{params.reasoningEffort}}');
  assert.deepEqual(mode.agent.requestOptions, { reasoningEffort: 'none' });
});

test('StarRouter 文本模型的推理档位只写中转站实测接受的枚举', () => {
  // 2026-10-19 用非法取值逐个探过 starrouter.io：端点回吐的合法值才写进目录，其余一律不声明。
  const measured = {
    'starrouter-gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
    'starrouter-deepseek-v4-pro': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'],
    'starrouter-qwen3.6-plus': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    'starrouter-glm-5.2': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'starrouter-grok-4.3': ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  };
  for (const [id, values] of Object.entries(measured)) {
    const mode = catalogJson.models.find((candidate) => candidate.id === id).modes[0];
    const param = mode.params.find((item) => item.key === 'reasoningEffort');
    assert.deepEqual(param.options, values, id);
    assert.equal(param.default, 'medium', id);
    assert.deepEqual(Object.keys(param.optionLabels), values, `${id} 每个档位都要有中文名`);
    assert.equal(mode.requestTemplate.reasoning_effort, '{{params.reasoningEffort}}');
    assert.ok(mode.capabilities.includes('reasoning'), `${id} 声明了档位就要同时向模型声明会推理`);
  }
  // kimi-k3 对 reasoning_effort 不做任何校验（连非法值都返回 200），claude-opus-4-8 当前没有可用渠道，
  // 两者都测不出真实档位，目录里就不许有这个开关。
  for (const id of ['starrouter-kimi-k3', 'starrouter-claude-opus-4-8']) {
    const mode = catalogJson.models.find((candidate) => candidate.id === id).modes[0];
    assert.equal(mode.params.find((item) => item.key === 'reasoningEffort'), undefined, id);
    assert.equal(mode.requestTemplate.reasoning_effort, undefined, id);
  }
});

test('StarRouter Grok 图片模型只公开已验证可用的文生图协议', () => {
  const models = catalogJson.models.filter((model) => [
    'starrouter-grok-imagine-image',
    'starrouter-grok-imagine-image-quality',
  ].includes(model.id));

  assert.deepEqual(models.map((model) => model.upstreamModel), [
    'grok-imagine-image',
    'grok-imagine-image-quality',
  ]);
  for (const model of models) {
    assert.equal(model.defaultMode, 'text-to-image');
    assert.deepEqual(model.modes.map((mode) => mode.id), ['text-to-image']);
    assert.equal(model.modes[0].endpoint.path, '/images/generations');
    assert.equal(model.modes[0].inputConstraints.images.max, 0);
  }
});

test('StarRouter Seedance 保留显式输入槽位并使用火山中转任务端点', () => {
  const models = catalogJson.models.filter((model) => model.id.startsWith('starrouter-doubao-seedance-2-0'));

  assert.deepEqual(models.map((model) => model.upstreamModel), [
    'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128',
    'doubao-seedance-2-0-mini-260615',
  ]);
  for (const model of models) {
    for (const mode of model.modes) {
      assert.equal(mode.endpoint.path, '/volcengine/doubao/contents/generations/tasks');
      assert.equal(mode.taskEndpoint.path, '/volcengine/doubao/contents/generations/tasks/{taskId}');
    }
    const referenceMode = model.modes.find((mode) => mode.inputMode === 'reference');
    assert.deepEqual(referenceMode.inputSlots, ['reference', 'inputVideo', 'referenceAudio']);
    assert.deepEqual(referenceMode.inputVariants[0].inputSlots, ['firstFrame', 'lastFrame']);
    assert.equal(referenceMode.inputVariants[0].requestFields.firstFrameImageContentRole, 'first_frame');
    assert.equal(referenceMode.inputVariants[0].requestFields.lastFrameImageContentRole, 'last_frame');
  }
});
