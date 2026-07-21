import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { initLlama, LlamaContext, releaseAllLlama } from 'llama.rn';
import { AIModel, InferenceParams } from '../types';
import { closeAllExternalModelUris, closeExternalModelUri, openExternalModelUri } from './external-model-file';

const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;
const BUILD20_MODEL_IMPORT_READY = true;
const CONFLICTING_TOOL_STOPS = new Set(['{"t":', '```json']);
const BUILD41_EXTERNAL_MODEL_REFERENCE = true;
export type ModelImportMode = 'external' | 'copy';

export interface InferenceDiagnostics {
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  promptTokens?: number;
  promptTokensPerSecond?: number;
  predictedTokens?: number;
  predictedTokensPerSecond?: number;
  callbackEvents: number;
  callbackCharacters: number;
  deduplicatedFinalUserMessage: boolean;
}

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

/** 从文件选择器导入或直接引用 GGUF 模型 */
export async function pickAndImportModel(mode: ModelImportMode = 'external'): Promise<AIModel | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: mode === 'copy',
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const fileName = asset.name;
  const sourceUri = asset.uri;
  if (!/\.gguf$/i.test(fileName)) throw new Error('请选择 GGUF 格式的模型文件');

  const modelId = `model_${Date.now()}`;
  if (mode === 'external') {
    let fileSize = asset.size ?? 0;
    if (fileSize <= 0 && sourceUri.startsWith('file://')) {
      const info = await FileSystem.getInfoAsync(sourceUri);
      fileSize = (info as { size?: number }).size ?? 0;
    }
    return {
      id: modelId,
      name: fileName.replace(/\.gguf$/i, ''),
      filePath: sourceUri,
      sourceUri,
      storageMode: 'external',
      fileSize,
      fileSizeLabel: fileSize > 0 ? formatFileSize(fileSize) : '大小将在加载时确认',
      format: 'gguf',
      addedAt: Date.now(),
      isLoaded: false,
    };
  }

  await ensureModelsDir();
  const destPath = `${MODELS_DIR}${modelId}_${fileName}`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destPath });
  } catch (error) {
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
    throw error;
  }
  const info = await FileSystem.getInfoAsync(destPath);
  const fileSize = (info as { size?: number }).size ?? 0;
  if (!info.exists || fileSize <= 0) {
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
    throw new Error('模型复制失败：目标文件不存在或大小为 0');
  }
  return {
    id: modelId,
    name: fileName.replace(/\.gguf$/i, ''),
    filePath: destPath,
    storageMode: 'copied',
    fileSize,
    fileSizeLabel: formatFileSize(fileSize),
    format: 'gguf',
    addedAt: Date.now(),
    isLoaded: false,
  };
}

/** 删除模型文件 */
export async function deleteModelFile(model: AIModel): Promise<void> {
  if (_completionInFlight > 0) {
    throw new Error('模型正在生成内容，不能删除。请等待生成结束后重试。');
  }
  if (model.storageMode === 'external') {
    await closeExternalModelUri(model.sourceUri ?? model.filePath);
    return;
  }
  await FileSystem.deleteAsync(model.filePath, { idempotent: true });
}

// ─── llama.rn Context Management ─────────────────────────────────────────────

let _activeContext: LlamaContext | null = null;
let _activeModelId: string | null = null;
let _completionInFlight = 0;
let _lastDiagnostics: InferenceDiagnostics | null = null;
let _activeExternalUri: string | null = null;

export function getActiveContext(): LlamaContext | null {
  return _activeContext;
}

export function getActiveModelId(): string | null {
  return _activeModelId;
}

export function isInferenceRunning(): boolean {
  return _completionInFlight > 0;
}

export function getLastInferenceDiagnostics(): InferenceDiagnostics | null {
  return _lastDiagnostics;
}

function formatRate(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '未知';
}

function installCompletionGuard(context: LlamaContext): LlamaContext {
  type CompletionFn = LlamaContext['completion'];
  const nativeCompletion = context.completion.bind(context) as CompletionFn;

  (context as unknown as { completion: CompletionFn }).completion = (async (
    params: Parameters<CompletionFn>[0],
    callback?: Parameters<CompletionFn>[1]
  ) => {
    if (_completionInFlight > 0) {
      throw new Error('已有推理任务正在运行，请等待当前生成结束');
    }

    const startedAt = Date.now();
    let callbackEvents = 0;
    let callbackCharacters = 0;
    let deduplicatedFinalUserMessage = false;

    const safeParams = { ...params } as typeof params & {
      stop?: string[];
      messages?: Array<{ role: string; content?: unknown }>;
    };

    // 项目原先把工具 JSON 的开头本身设为 stop，导致模型刚开始调用工具就被截断。
    safeParams.stop = (safeParams.stop ?? []).filter(
      (stop) => typeof stop === 'string' && stop.length > 0 && !CONFLICTING_TOOL_STOPS.has(stop)
    );

    // 聊天页先把用户消息写入 store，随后又追加一次相同 userText。
    // 在原生推理入口统一移除末尾连续重复的用户消息，避免 prompt 重复。
    const messages = safeParams.messages;
    if (Array.isArray(messages) && messages.length >= 2) {
      const last = messages[messages.length - 1];
      const previous = messages[messages.length - 2];
      if (
        last?.role === 'user' &&
        previous?.role === 'user' &&
        typeof last.content === 'string' &&
        last.content === previous.content
      ) {
        safeParams.messages = [...messages.slice(0, -1)];
        deduplicatedFinalUserMessage = true;
      }
    }

    const wrappedCallback = callback
      ? ((data: Parameters<NonNullable<typeof callback>>[0]) => {
          const token = (data as { token?: string }).token ?? '';
          callbackEvents += 1;
          callbackCharacters += token.length;
          callback(data);
        })
      : undefined;

    _completionInFlight += 1;
    try {
      const result = await nativeCompletion(safeParams, wrappedCallback);
      const finishedAt = Date.now();
      const timings = (result as unknown as {
        timings?: {
          prompt_n?: number;
          prompt_per_second?: number;
          predicted_n?: number;
          predicted_per_second?: number;
        };
      }).timings;

      _lastDiagnostics = {
        startedAt,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
        promptTokens: timings?.prompt_n,
        promptTokensPerSecond: timings?.prompt_per_second,
        predictedTokens: timings?.predicted_n,
        predictedTokensPerSecond: timings?.predicted_per_second,
        callbackEvents,
        callbackCharacters,
        deduplicatedFinalUserMessage,
      };

      if (callback) {
        const summary =
          `\n\n[性能诊断] Prefill ${formatRate(timings?.prompt_per_second)} tok/s` +
          `；Decode ${formatRate(timings?.predicted_per_second)} tok/s` +
          `；原生输出 ${timings?.predicted_n ?? '未知'} tokens` +
          `；耗时 ${((finishedAt - startedAt) / 1000).toFixed(2)}s` +
          `${deduplicatedFinalUserMessage ? '；已去除重复用户消息' : ''}`;
        callback({ token: summary } as Parameters<NonNullable<typeof callback>>[0]);
      }

      return result;
    } finally {
      _completionInFlight = Math.max(0, _completionInFlight - 1);
    }
  }) as CompletionFn;

  return context;
}

/** 加载模型。外部模型通过持久化 SAF 文件描述符直接映射，不复制权重。 */
export async function loadModel(
  model: AIModel,
  params: InferenceParams,
  onProgress?: (progress: number) => void
): Promise<LlamaContext> {
  if (_completionInFlight > 0) throw new Error('模型正在生成内容，不能切换或重新加载模型');

  if (_activeContext) {
    await _activeContext.release();
    _activeContext = null;
  }
  if (_activeExternalUri) {
    await closeExternalModelUri(_activeExternalUri);
    _activeExternalUri = null;
  }
  _activeModelId = null;

  let resolvedPath = model.filePath;
  const externalUri = model.storageMode === 'external' ? (model.sourceUri ?? model.filePath) : null;
  if (externalUri) {
    const opened = await openExternalModelUri(externalUri);
    resolvedPath = opened.path.startsWith('/') ? `file://${opened.path}` : opened.path;
  }

  try {
    const context = await initLlama(
      {
        model: resolvedPath,
        n_ctx: params.n_ctx,
        n_batch: params.n_batch,
        n_ubatch: Math.max(1, Math.min(params.n_ubatch, params.n_batch)),
        n_threads: params.n_threads,
        n_gpu_layers: params.n_gpu_layers,
        use_mlock: params.use_mlock,
        use_mmap: params.use_mmap,
        n_parallel: 1,
        kv_unified: true,
        no_extra_bufts: true,
      } as Parameters<typeof initLlama>[0],
      (progress) => onProgress?.(progress)
    );
    _activeContext = installCompletionGuard(context);
    _activeModelId = model.id;
    _activeExternalUri = externalUri;
    _lastDiagnostics = null;
    return _activeContext;
  } catch (error) {
    if (externalUri) await closeExternalModelUri(externalUri);
    _activeExternalUri = null;
    _activeModelId = null;
    throw error;
  }
}

/** 释放当前模型 */
export async function releaseModel(): Promise<void> {
  if (_completionInFlight > 0) {
    throw new Error('模型正在生成内容，不能卸载。请等待生成结束后重试。');
  }
  if (_activeContext) {
    await _activeContext.release();
    _activeContext = null;
    _activeModelId = null;
  }
  if (_activeExternalUri) {
    await closeExternalModelUri(_activeExternalUri);
    _activeExternalUri = null;
  }
}

/** 释放所有 llama.rn 上下文 */
export async function releaseAll(): Promise<void> {
  if (_completionInFlight > 0) {
    throw new Error('模型正在生成内容，不能释放全部上下文');
  }
  await releaseAllLlama();
  await closeAllExternalModelUris();
  _activeContext = null;
  _activeModelId = null;
  _activeExternalUri = null;
  _lastDiagnostics = null;
}
