import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { initLlama, LlamaContext, releaseAllLlama } from 'llama.rn';
import { AIModel, InferenceParams } from '../types';
import {
  closeAllExternalModelUris,
  closeExternalModelUri,
  resolveExternalModelUri,
} from './external-model-file';
import {
  getRuntimeMemorySnapshot,
  RuntimeMemorySnapshot,
} from './runtime-memory';

const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;
const CONFLICTING_TOOL_STOPS = new Set(['{"t":', '```json']);
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
  memoryGuardTriggered: boolean;
  lastMemorySnapshot?: RuntimeMemorySnapshot;
}

let _activeContext: LlamaContext | null = null;
let _activeModelId: string | null = null;
let _completionInFlight = 0;
let _lastDiagnostics: InferenceDiagnostics | null = null;
let _activeExternalUri: string | null = null;
let _activeInferenceParams: InferenceParams | null = null;

export async function ensureModelsDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 直接使用原文件只接受能解析为真实本机文件路径的 URI。content:// 代理流、
 * 网盘和不可 mmap 的提供方会在导入阶段失败，避免“导入成功、加载失败”。
 */
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
    const resolved = await resolveExternalModelUri(sourceUri);
    const fileSize = resolved.size > 0 ? resolved.size : (asset.size ?? 0);
    return {
      id: modelId,
      name: fileName.replace(/\.gguf$/i, ''),
      filePath: resolved.path,
      sourceUri,
      storageMode: 'external',
      fileSize,
      fileSizeLabel: fileSize > 0 ? formatFileSize(fileSize) : '大小未知',
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

async function shouldStopForMemoryPressure(
  params: InferenceParams,
  snapshot: RuntimeMemorySnapshot | null
): Promise<{ stop: boolean; reserveMb: number }> {
  if (!params.memory_guard_enabled || !snapshot) return { stop: false, reserveMb: 0 };
  const reserveMb = Math.max(params.memory_guard_reserve_mb, snapshot.thresholdMb * 1.25);
  return {
    stop: snapshot.lowMemory || snapshot.availMemMb < reserveMb,
    reserveMb,
  };
}

function installCompletionGuard(context: LlamaContext): LlamaContext {
  type CompletionFn = LlamaContext['completion'];
  const nativeCompletion = context.completion.bind(context) as CompletionFn;

  (context as unknown as { completion: CompletionFn }).completion = (async (
    params: Parameters<CompletionFn>[0],
    callback?: Parameters<CompletionFn>[1]
  ) => {
    if (_completionInFlight > 0) throw new Error('已有推理任务正在运行，请等待当前生成结束');

    const activeParams = _activeInferenceParams;
    if (!activeParams) throw new Error('推理参数状态丢失，请重新加载模型');

    const preflight = await getRuntimeMemorySnapshot().catch(() => null);
    const preflightDecision = await shouldStopForMemoryPressure(activeParams, preflight);
    if (preflightDecision.stop && preflight) {
      throw new Error(
        `系统可用内存仅 ${preflight.availMemMb.toFixed(0)} MB，低于安全保留值 ${preflightDecision.reserveMb.toFixed(0)} MB。请先关闭其他大型应用、降低上下文或重新加载低内存参数。`
      );
    }

    const startedAt = Date.now();
    let callbackEvents = 0;
    let callbackCharacters = 0;
    let deduplicatedFinalUserMessage = false;
    let memoryGuardTriggered = false;
    let lastMemorySnapshot = preflight ?? undefined;
    let polling = false;

    const safeParams = { ...params } as typeof params & {
      stop?: string[];
      messages?: Array<{ role: string; content?: unknown }>;
    };
    safeParams.stop = (safeParams.stop ?? []).filter(
      (stop) => typeof stop === 'string' && stop.length > 0 && !CONFLICTING_TOOL_STOPS.has(stop)
    );

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

    const pollMemory = async () => {
      if (polling || memoryGuardTriggered || !activeParams.memory_guard_enabled) return;
      polling = true;
      try {
        const snapshot = await getRuntimeMemorySnapshot();
        if (!snapshot) return;
        lastMemorySnapshot = snapshot;
        const decision = await shouldStopForMemoryPressure(activeParams, snapshot);
        if (decision.stop) {
          memoryGuardTriggered = true;
          await context.stopCompletion().catch(() => {});
        }
      } finally {
        polling = false;
      }
    };

    const memoryTimer = activeParams.memory_guard_enabled
      ? setInterval(() => { void pollMemory(); }, 1200)
      : null;

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
        memoryGuardTriggered,
        lastMemorySnapshot,
      };

      if (memoryGuardTriggered) {
        const available = lastMemorySnapshot?.availMemMb;
        throw new Error(
          `内存保护已主动停止生成${available ? `：系统可用内存降至 ${available.toFixed(0)} MB` : ''}。已生成的内容已保留；请降低上下文、batch、KV 缓存精度或关闭其他应用后继续。`
        );
      }
      return result;
    } finally {
      if (memoryTimer) clearInterval(memoryTimer);
      _completionInFlight = Math.max(0, _completionInFlight - 1);
    }
  }) as CompletionFn;

  return context;
}

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
  _activeInferenceParams = null;

  let resolvedPath = model.filePath;
  const externalUri = model.storageMode === 'external' ? (model.sourceUri ?? model.filePath) : null;
  if (externalUri) {
    const resolved = await resolveExternalModelUri(externalUri);
    resolvedPath = resolved.path;
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
        cache_type_k: params.cache_type_k,
        cache_type_v: params.cache_type_v,
        n_parallel: 1,
        kv_unified: true,
        no_extra_bufts: params.no_extra_bufts,
        flash_attn_type: params.n_gpu_layers > 0 ? 'auto' : 'off',
        swa_full: false,
      } as Parameters<typeof initLlama>[0],
      (progress) => onProgress?.(progress)
    );
    _activeInferenceParams = { ...params };
    _activeContext = installCompletionGuard(context);
    _activeModelId = model.id;
    _activeExternalUri = externalUri;
    _lastDiagnostics = null;
    return _activeContext;
  } catch (error) {
    if (externalUri) await closeExternalModelUri(externalUri);
    _activeExternalUri = null;
    _activeModelId = null;
    _activeInferenceParams = null;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`模型加载失败：${detail}`);
  }
}

export async function releaseModel(): Promise<void> {
  if (_completionInFlight > 0) {
    throw new Error('模型正在生成内容，不能卸载。请等待生成结束后重试。');
  }
  if (_activeContext) {
    await _activeContext.release();
    _activeContext = null;
  }
  if (_activeExternalUri) {
    await closeExternalModelUri(_activeExternalUri);
    _activeExternalUri = null;
  }
  _activeModelId = null;
  _activeInferenceParams = null;
}

export async function releaseAll(): Promise<void> {
  if (_completionInFlight > 0) throw new Error('模型正在生成内容，不能释放全部上下文');
  await releaseAllLlama();
  await closeAllExternalModelUris();
  _activeContext = null;
  _activeModelId = null;
  _activeExternalUri = null;
  _activeInferenceParams = null;
  _lastDiagnostics = null;
}
