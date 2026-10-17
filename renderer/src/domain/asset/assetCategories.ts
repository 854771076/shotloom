// 素材分类是产品数据模型的一部分：store 在归一化和写入资产时就要按分类查找，
// 因此这份表不能留在界面常量里，否则数据层会反向依赖界面层。
import type { IconName } from '@/app/components/IconSymbol';

export interface AssetCategory {
  id: string;
  label: string;
  icon: IconName;
  aliases: string[];
}

const characters: AssetCategory = { id: 'characters', label: '角色设定', icon: 'user', aliases: ['actors'] };
const scenes: AssetCategory = { id: 'scenes', label: '场景设定', icon: 'pin', aliases: ['locations'] };
const props: AssetCategory = { id: 'props', label: '道具元素', icon: 'box', aliases: [] };
const styles: AssetCategory = { id: 'styles', label: '风格参考', icon: 'image', aliases: ['costumes'] };
const shots: AssetCategory = { id: 'shots', label: '分镜镜头', icon: 'grid', aliases: [] };

export const assetCategories: AssetCategory[] = [characters, scenes, props, styles, shots];

// 未匹配到分类时回落到第一个分类；显式导出常量，避免各处用数组下标猜测默认值。
export const defaultAssetCategory = characters;
