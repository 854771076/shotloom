import assert from 'node:assert/strict';
import test from 'node:test';

import { renderProtocolTemplate } from '../renderer/src/utils/modelProtocol.ts';
import { loadModelCatalog } from './helpers/modelCatalog.mjs';
import { createRendererEnv } from './helpers/rendererSsr.mjs';
import { readSource } from './helpers/sourceContract.mjs';

const catalog = loadModelCatalog();
const adapterSource = readSource('renderer/src/domain/provider/adapters/minimax.ts');
const speechModes = ['minimax-speech-2.8-hd', 'minimax-speech-2.8-turbo']
  .map((id) => catalog.models.find((model) => model.id === id))
  .map((model) => ({ model, mode: model.modes[0] }));
const music = catalog.models.find((model) => model.id === 'minimax-music-3.0');
const musicMode = music.modes[0];

const speechParams = {
  voice: 'female-shaonv', speed: 1, volume: 1, pitch: 0,
  languageBoost: 'auto', sampleRate: 32000, bitrate: 128000,
};

test('MiniMax 适配器只有一个官方地址并覆盖视频与音频', () => {
  assert.match(adapterSource, /id: 'minimax'/);
  assert.match(adapterSource, /baseUrl: 'https:\/\/api\.minimax\.io'/);
});

test('MiniMax 官方 Speech 2.8 走 t2a_v2 同步协议并取回 URL 结果', () => {
  assert.deepEqual(speechModes.map(({ model }) => [model.id, model.upstreamModel, model.sortOrder]), [
    ['minimax-speech-2.8-hd', 'speech-2.8-hd', 19],
    ['minimax-speech-2.8-turbo', 'speech-2.8-turbo', 20],
  ]);
  for (const { model, mode } of speechModes) {
    assert.equal(model.provider, 'minimax');
    assert.equal(model.type, 'audioGeneration');
    assert.equal(model.defaultMode, 'text-to-speech');
    assert.deepEqual(mode.endpoint, { method: 'POST', path: '/v1/t2a_v2', scope: 'root' });
    assert.equal(mode.taskEndpoint, undefined, 't2a_v2 是同步接口，不该有任务轮询');
    assert.equal(mode.isAsync, undefined);

    // 官方只有在 output_format=url 时才返回可下载的 data.audio；hex 需要单独的解码车道。
    const body = renderProtocolTemplate(mode.requestTemplate, {
      model: model.upstreamModel, prompt: '你好', params: speechParams,
    });
    assert.deepEqual(body, {
      model: model.upstreamModel,
      text: '你好',
      stream: false,
      output_format: 'url',
      language_boost: 'auto',
      voice_setting: { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    });
    assert.equal(mode.resultUrlPath, 'data.audio');
    assert.equal(mode.resultMimeType, 'audio/mpeg');
    assert.equal(mode.resultFileExtension, 'mp3');
  }

  const { mode } = speechModes[0];
  const voice = mode.params.find((param) => param.key === 'voice');
  assert.equal(voice.presentation.control, 'voice');
  const speed = mode.params.find((param) => param.key === 'speed');
  assert.deepEqual([speed.presentation.min, speed.presentation.max], [0.5, 2]);
  const languageBoost = mode.params.find((param) => param.key === 'languageBoost');
  assert.equal(languageBoost.options.length, 41, '官方 language_boost 枚举必须完整公开');
  assert.deepEqual(
    mode.params.filter((param) => param.type === 'select' && param.numeric).map((param) => param.key),
    ['sampleRate', 'bitrate'],
  );
});

test('音频参数面板只用一套控件语言，倍率滑杆按对数轨道声明', () => {
  const controls = new Map();
  for (const audioMode of [...speechModes.map(({ mode }) => mode), musicMode]) {
    for (const param of audioMode.params || []) {
      const presentation = param.presentation || {};
      controls.set(param.key, presentation.control || '选项块');
      if (param.key === 'speed' || param.key === 'volume') {
        assert.equal(presentation.scale, 'log', `${param.key} 是倍率参数：线性轨道会把默认值 1 压在左端，看起来像空轨`);
      }
      if ((param.key === 'sampleRate' || param.key === 'bitrate') && (param.options || []).length <= 6) {
        assert.notEqual(presentation.control, 'select', `${param.key} 只有 ${param.options.length} 档，必须铺成选项块`);
      }
    }
  }
  assert.equal(controls.get('voice'), 'voice', '音色清单来自系统音色库，只能用选择器');
  assert.equal(controls.get('languageBoost'), 'select', '41 个语种铺不成选项块，只有它可以是下拉');
  assert.equal(controls.get('lyrics'), 'text');
});

test('MiniMax Music 3.0 只发出官方声明的参数，歌词是自由文本', () => {
  assert.equal(music.upstreamModel, 'music-3.0');
  assert.equal(music.type, 'audioGeneration');
  assert.deepEqual(musicMode.endpoint, { method: 'POST', path: '/v1/music_generation', scope: 'root' });
  assert.equal(musicMode.taskEndpoint, undefined);

  const body = renderProtocolTemplate(musicMode.requestTemplate, {
    model: 'music-3.0',
    prompt: '雨夜的爵士',
    params: { lyrics: '', instrumental: false, lyricsOptimizer: false, sampleRate: 44100, bitrate: 256000 },
  });
  assert.deepEqual(body, {
    model: 'music-3.0',
    prompt: '雨夜的爵士',
    lyrics: '',
    stream: false,
    output_format: 'url',
    is_instrumental: false,
    lyrics_optimizer: false,
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
  });
  assert.equal(musicMode.params.find((param) => param.key === 'lyrics').presentation.control, 'text');
  assert.equal(musicMode.resultUrlPath, 'data.audio');
  assert.equal(musicMode.resultMimeType, 'audio/mpeg');
  assert.equal(musicMode.resultFileExtension, 'mp3');
});

test('MiniMax 把失败写在 HTTP 200 的响应体里，提交回执必须带真实原因', async () => {
  const env = await createRendererEnv();
  try {
    const { desktopApi } = await env.load('services/desktopApi');
    const { findProviderAdapter } = await env.load('domain/provider/adapters/index');
    const { resolveModelRuntimeContract } = await env.load('domain/catalog/ModelCatalog');
    const adapter = findProviderAdapter('minimax');
    const speechContract = resolveModelRuntimeContract('audioGeneration', 'minimax-speech-2.8-hd', [], 'text-to-speech');
    const videoContract = resolveModelRuntimeContract('videoGeneration', 'MiniMax-H3', [], 'text-to-video');

    const previousChat = desktopApi.model.chatCompletion;
    const previousVideo = desktopApi.model.videoGeneration;
    const previousTask = desktopApi.model.videoTask;
    try {
      desktopApi.model.chatCompletion = async () => ({
        base_resp: { status_code: 2013, status_msg: 'invalid params, voice not found' },
      });
      const failed = await adapter.submit(adapter.compileRequest({
        taskType: 'audioGeneration', model: 'minimax-speech-2.8-hd', prompt: '你好',
        modelContract: speechContract, params: speechParams,
      }));
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error, 'invalid params, voice not found');

      desktopApi.model.chatCompletion = async () => ({
        base_resp: { status_code: 0 },
        data: { audio: 'https://file.minimax.io/result.mp3' },
      });
      const succeeded = await adapter.submit(adapter.compileRequest({
        taskType: 'audioGeneration', model: 'minimax-speech-2.8-hd', prompt: '你好',
        modelContract: speechContract, params: speechParams,
      }));
      assert.equal(succeeded.status, 'completed');
      assert.deepEqual(succeeded.result.files, [
        { url: 'https://file.minimax.io/result.mp3', mimeType: 'audio/mpeg', name: 'result.mp3' },
      ]);

      // 异步视频提交失败时同样要报原因，而不是"缺少任务 ID 路径"。
      desktopApi.model.videoGeneration = async () => ({
        base_resp: { status_code: 1004, status_msg: 'login fail: Please check the API Key' },
      });
      const videoFailed = await adapter.submit(adapter.compileRequest({
        taskType: 'videoGeneration', model: 'MiniMax-H3', prompt: '镜头推进',
        modelContract: videoContract, params: { duration: 5, resolution: '768P', aspectRatio: '16:9' },
      }));
      assert.equal(videoFailed.status, 'failed');
      assert.equal(videoFailed.error, 'login fail: Please check the API Key');

      desktopApi.model.videoTask = async () => ({
        base_resp: { status_code: 1002, status_msg: 'quota exceeded' },
      });
      const polled = await adapter.poll(
        { remoteTaskId: 'task-1', status: 'running', progress: 0, result: {}, error: '', raw: {} },
        videoContract,
      );
      assert.equal(polled.status, 'failed');
      assert.equal(polled.error, 'quota exceeded');
    } finally {
      desktopApi.model.chatCompletion = previousChat;
      desktopApi.model.videoGeneration = previousVideo;
      desktopApi.model.videoTask = previousTask;
    }
  } finally {
    await env.dispose();
  }
});

test('没有声明 errorCodePath 的厂商不受 body 内错误判定影响', async () => {
  const env = await createRendererEnv();
  try {
    const { desktopApi } = await env.load('services/desktopApi');
    const { findProviderAdapter } = await env.load('domain/provider/adapters/index');
    const { resolveModelRuntimeContract } = await env.load('domain/catalog/ModelCatalog');
    const contract = resolveModelRuntimeContract('textGeneration', 'deepseek-flash', [], undefined);
    assert.equal(contract.errorCodePath, undefined, '文本模型不该被 body 内错误码判定拦下');
    const previousChat = desktopApi.model.chatCompletion;
    try {
      desktopApi.model.chatCompletion = async () => ({ choices: [{ message: { content: 'ok' } }] });
      const task = await findProviderAdapter(contract.provider).submit(
        findProviderAdapter(contract.provider).compileRequest({
          taskType: 'textGeneration', model: contract.modelId, prompt: 'hi', modelContract: contract, params: {},
        }),
      );
      assert.equal(task.status, 'completed');
      assert.equal(task.result.text, 'ok');
    } finally {
      desktopApi.model.chatCompletion = previousChat;
    }
  } finally {
    await env.dispose();
  }
});
