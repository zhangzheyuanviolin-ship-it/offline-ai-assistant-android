import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { initLlama, LlamaContext, releaseAllLlama } from 'llama.rn';
import { AIModel, InferenceParams } from '../types';

const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
}

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 从文件选择器导入 GGUF 模型 */
export async function pickAndImportModel(): Promise<AIModel | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const fileName = asset.name;
  const sourceUri = asset.uri;

  await ensureModelsDir();

  const modelId = `model_${Date.now()}`;
  const destPath = `${MODELS_DIR}${modelId}_${fileName}`;

  // 复制到应用私有目录（持久化）
  await FileSystem.copyAsync({ from: sourceUri, to: destPath });

  const fileInfo = await FileSystem.getInfoAsync(destPath);
  const fileSize = (fileInfo as { size?: number }).size ?? 0;

  const model: AIModel = {
    id: modelId,
    name: fileName.replace(/\.gguf$/i, ''),
    filePath: destPath,
    fileSize,
    fileSizeLabel: formatFileSize(fileSize),
    format: 'gguf',
    addedAt: Date.now(),
    isLoaded: false,
  };

  return model;
}

/** 删除模型文件 */
export async function deleteModelFile(model: AIModel): Promise<void> {
  await FileSystem.deleteAsync(model.filePath, { idempotent: true });
}

// ─── llama.rn Context Management ─────────────────────────────────────────────

let _activeContext: LlamaContext | null = null;
let _activeModelId: string | null = null;

export function getActiveContext(): LlamaContext | null {
  return _activeContext;
}

export function getActiveModelId(): string | null {
  return _activeModelId;
}

/** 加载模型到内存（llama.rn initLlama） */
export async function loadModel(
  model: AIModel,
  params: InferenceParams,
  onProgress?: (progress: number) => void
): Promise<LlamaContext> {
  // 先释放已加载的模型
  if (_activeContext) {
    await _activeContext.release();
    _activeContext = null;
    _activeModelId = null;
  }

  const context = await initLlama(
    {
      model: model.filePath,
      n_ctx: params.n_ctx,
      n_batch: params.n_batch,
      n_threads: params.n_threads,
      n_gpu_layers: params.n_gpu_layers,
      use_mlock: false,
      use_mmap: true,
    },
    (progress) => {
      onProgress?.(progress);
    }
  );

  _activeContext = context;
  _activeModelId = model.id;
  return context;
}

/** 释放当前模型 */
export async function releaseModel(): Promise<void> {
  if (_activeContext) {
    await _activeContext.release();
    _activeContext = null;
    _activeModelId = null;
  }
}

/** 释放所有 llama.rn 上下文 */
export async function releaseAll(): Promise<void> {
  await releaseAllLlama();
  _activeContext = null;
  _activeModelId = null;
}
