import { reactive } from '@/store/domainReactivity';
import { desktopApi } from '@/services/desktopApi';
import { getBuiltInRecipe } from '@/services/builtInRecipes';

// 模板条目来自磁盘 JSON 与内置库；必填字段与 upsertRecipe 的规范化输出一致，
// 索引签名容忍磁盘上的历史扩展字段。
type AnyRecord = Record<string, any>;

export interface RecipeRecord {
  id: string;
  name: string;
  description: string;
  generationType: string;
  operationTypes: string[];
  requiredElements: string[];
  systemPrompt: string;
  version: number;
  enabled: boolean;
  builtIn?: boolean;
  updatedAt: string;
  [key: string]: unknown;
}

export const recipesStore = reactive({
  storageVersion: 1,
  recipes: [] as RecipeRecord[],
});

function recipeId(name = '') {
  const base = String(name).trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'recipe';
  const used = new Set(recipesStore.recipes.map((recipe) => recipe.id));
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  return id;
}

export async function loadGlobalRecipes() {
  const storage = await desktopApi.recipes.getGlobal();
  recipesStore.storageVersion = Number(storage.storageVersion) || 1;
  recipesStore.recipes = Array.isArray(storage.recipes) ? storage.recipes : [];
}

export async function saveGlobalRecipes() {
  const snapshot = JSON.parse(JSON.stringify({
    storageVersion: recipesStore.storageVersion,
    recipes: recipesStore.recipes,
  }));
  const storage = await desktopApi.recipes.setGlobal(snapshot);
  recipesStore.storageVersion = Number(storage.storageVersion) || 1;
  recipesStore.recipes = Array.isArray(storage.recipes) ? storage.recipes : [];
}

export function createRecipeDraft() {
  return {
    id: recipeId('custom-recipe'),
    name: '新提示词模板',
    description: '说明这个提示词模板适合增强哪类提示词。',
    generationType: 'image',
    operationTypes: ['image'],
    systemPrompt: '写清主体、动作、环境、镜头和风格，输出可直接运行的完整提示词。',
    requiredElements: ['主体'],
    version: 1,
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
}

export async function upsertRecipe(recipe: AnyRecord): Promise<RecipeRecord> {
  const existing = recipesStore.recipes.find((item) => item.id === String(recipe.id || '').trim());
  const normalized = {
    ...recipe,
    id: String(recipe.id || '').trim(),
    name: String(recipe.name || '').trim(),
    description: String(recipe.description || '').trim(),
    operationTypes: [...new Set((recipe.operationTypes || []).map((value: unknown) => String(value).trim()).filter(Boolean))],
    requiredElements: [...new Set((recipe.requiredElements || []).map((value: unknown) => String(value).trim()).filter(Boolean))],
    systemPrompt: String(recipe.systemPrompt || '').trim(),
    version: Math.max(1, Number(recipe.version) || 1),
    enabled: recipe.enabled !== false,
    builtIn: existing?.builtIn === true,
    updatedAt: new Date().toISOString(),
  } as RecipeRecord;
  if (!/^[a-z0-9:_-]{1,80}$/.test(normalized.id)) throw new Error('提示词模板 ID 仅允许小写字母、数字、:、-、_');
  if (!normalized.name || !normalized.description || !normalized.systemPrompt) {
    throw new Error('提示词模板名称、用途说明和 System Prompt 均不能为空');
  }
  if (!['image', 'video', 'audio', 'text'].includes(normalized.generationType)) {
    throw new Error(`提示词模板的生成类型无效：${normalized.generationType || '空'}`);
  }
  if (!normalized.operationTypes.length || !normalized.requiredElements.length) {
    throw new Error('提示词模板的 Operation Types 和必需元素均不能为空');
  }
  const index = recipesStore.recipes.findIndex((item) => item.id === normalized.id);
  if (index >= 0) recipesStore.recipes[index] = normalized as RecipeRecord;
  else recipesStore.recipes.push(normalized);
  await saveGlobalRecipes();
  return normalized;
}

export async function toggleRecipe(recipeIdValue: string) {
  const recipe = recipesStore.recipes.find((item) => item.id === recipeIdValue);
  if (!recipe) return;
  recipe.enabled = recipe.enabled === false;
  await saveGlobalRecipes();
}

export async function deleteRecipe(recipeIdValue: string) {
  if (recipesStore.recipes.find((recipe) => recipe.id === recipeIdValue)?.builtIn) return;
  recipesStore.recipes = recipesStore.recipes.filter((recipe) => recipe.id !== recipeIdValue);
  await saveGlobalRecipes();
}

export async function resetRecipeToBuiltIn(recipeIdValue: string) {
  const original = getBuiltInRecipe(recipeIdValue);
  const current = recipesStore.recipes.find((recipe) => recipe.id === recipeIdValue);
  if (!original || !current) return false;
  const enabled = current.enabled !== false;
  recipesStore.recipes[recipesStore.recipes.indexOf(current)] = {
    ...JSON.parse(JSON.stringify(original)),
    enabled,
    builtIn: true,
    updatedAt: new Date().toISOString(),
  };
  await saveGlobalRecipes();
  return true;
}
