import { DeclarativeAdapter } from './declarative';

export const minimaxAdapter = new DeclarativeAdapter({
  id: 'minimax',
  name: 'MiniMax',
  description: 'MiniMax 官方接口（H3 视频、Speech 语音、Music 音乐）',
  iconId: 'minimax',
  baseUrl: 'https://api.minimax.io',
});
