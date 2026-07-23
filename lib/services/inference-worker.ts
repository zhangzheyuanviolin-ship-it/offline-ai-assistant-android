import { NativeModules } from 'react-native';
import { initLlama, releaseAllLlama, type LlamaContext } from 'llama.rn';
import type { InferenceParams } from '../types';

interface InferenceProcessMemorySnapshot {
  timestamp: number;
  pid: number;
  processName: string;
  totalPssMb: number;
  pssAnonMb: number;
  pssFileMb: number;
  pssShmemMb: number;
  rssMb: number;
  swapPssMb: number;
  privateCleanMb: number;
  privateDirtyMb: number;
  sharedCleanMb: number;
  nativeHeapAllocatedMb: number;
  nativeHeapSizeMb: number;
  availMemMb: number;
  thresholdMb: number;
  lowMemory: boolean;
}

interface CacheDropResult {
  success: boolean;
  message?: string;
}

const WorkerBridge = NativeModules.InferenceWorkerBridge as {
  emit(requestId: string, type: string, payloadJson: string): void;
  ready(): void;
  waitForCommand(): Promise<string>;
  getMemorySnapshot(): Promise<InferenceProcessMemorySnapshot>;
  appendMemoryDiagnostic(json: string): Promise<void>;
  dropFileCache(modelPath: string): Promise<CacheDropResult>;
};

let activeContext: LlamaContext | null = null;
let activeModelId: string | null = null;
let activeModelPath: string | null = null;
let activeParams: InferenceParams | null = null;
let streamCallbacks = 0;
let diagnosticBusy = false;

function emit(requestId: string, type: string, payload: unknown): void {
  WorkerBridge.emit(requestId, type, JSON.stringify(payload ?? null));
}

async function captureMemory(
  requestId: string,
  stage: string,
  options: {
    force?: boolean;
    cacheDropAttempted?: boolean;
    cacheDropResult?: CacheDropResult | null;
  } = {}
): Promise<void> {
  const params = activeParams;
  if (!options.force && !params?.memory_diagnostics_enabled) return;
  if (diagnosticBusy) return;
  diagnosticBusy = true;
  try {
    const snapshot = await WorkerBridge.getMemorySnapshot();
    const record = {
      ...snapshot,
      stage,
      requestId,
      modelId: activeModelId,
      modelPath: activeModelPath,
      tokenCallbacks: streamCallbacks,
      nCtx: params?.n_ctx ?? null,
      nBatch: params?.n_batch ?? null,
      nUbatch: params?.n_ubatch ?? null,
      cacheTypeK: params?.cache_type_k ?? null,
      cacheTypeV: params?.cache_type_v ?? null,
      lowResidencyEnabled: params?.low_residency_enabled ?? false,
      cacheDropAttempted: options.cacheDropAttempted ?? false,
      cacheDropSuccess: options.cacheDropResult?.success ?? null,
      cacheDropMessage: options.cacheDropResult?.message ?? null,
    };
    await WorkerBridge.appendMemoryDiagnostic(JSON.stringify(record));
  } catch {
    // Diagnostics must never interrupt inference.
  } finally {
    diagnosticBusy = false;
  }
}

function maybeCaptureDuringStream(requestId: string): void {
  const params = activeParams;
  if (!params) return;

  const diagnosticInterval = Math.max(16, params.memory_diagnostics_interval_tokens || 64);
  const lowResidencyInterval = Math.max(16, params.low_residency_interval_tokens || 64);
  const shouldDiagnose = params.memory_diagnostics_enabled && streamCallbacks % diagnosticInterval === 0;
  const shouldDrop = params.low_residency_enabled
    && Boolean(activeModelPath)
    && streamCallbacks % lowResidencyInterval === 0;

  if (!shouldDiagnose && !shouldDrop) return;

  void (async () => {
    let cacheDropResult: CacheDropResult | null = null;
    if (shouldDrop && activeModelPath) {
      try {
        cacheDropResult = await WorkerBridge.dropFileCache(activeModelPath);
      } catch (error) {
        cacheDropResult = {
          success: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await captureMemory(requestId, shouldDrop ? 'stream_after_cache_drop' : 'stream', {
      force: shouldDrop,
      cacheDropAttempted: shouldDrop,
      cacheDropResult,
    });
  })();
}

async function handleCommand(raw: string): Promise<void> {
  let command: {
    requestId: string;
    type: string;
    modelId?: string;
    modelPath?: string;
    params?: Record<string, unknown>;
  };
  try {
    command = JSON.parse(raw);
  } catch {
    return;
  }

  const { requestId, type } = command;
  try {
    if (type === 'load') {
      if (!command.modelPath || !command.params) throw new Error('模型路径或推理参数缺失');
      emit(requestId, 'progress', { progress: 1, stage: 'worker_received_load' });
      if (activeContext) {
        await activeContext.release();
        activeContext = null;
      }
      activeModelId = command.modelId ?? null;
      activeModelPath = command.modelPath;
      activeParams = command.params as unknown as InferenceParams;
      streamCallbacks = 0;
      await captureMemory(requestId, 'before_load', { force: true });

      const params = activeParams;
      activeContext = await initLlama(
        {
          model: command.modelPath,
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
        (progress) => emit(requestId, 'progress', { progress, stage: 'llama_loading' })
      );
      await captureMemory(requestId, 'after_load', { force: true });
      emit(requestId, 'result', { loaded: true, modelId: activeModelId });
      return;
    }

    if (type === 'completion') {
      if (!activeContext) throw new Error('独立推理进程中没有已加载模型');
      streamCallbacks = 0;
      await captureMemory(requestId, 'completion_start', { force: true });
      const result = await activeContext.completion(
        (command.params ?? {}) as Parameters<LlamaContext['completion']>[0],
        (data) => {
          streamCallbacks += 1;
          emit(requestId, 'stream', data);
          maybeCaptureDuringStream(requestId);
        }
      );
      await captureMemory(requestId, 'completion_end', { force: true });
      emit(requestId, 'result', result);
      return;
    }

    if (type === 'stop') {
      if (activeContext) await activeContext.stopCompletion();
      await captureMemory(requestId, 'completion_stopped', { force: true });
      emit(requestId, 'result', { stopped: true });
      return;
    }

    if (type === 'release') {
      await captureMemory(requestId, 'before_release', { force: true });
      if (activeContext) await activeContext.release();
      activeContext = null;
      activeModelId = null;
      activeModelPath = null;
      activeParams = null;
      streamCallbacks = 0;
      emit(requestId, 'result', { released: true });
      return;
    }

    if (type === 'releaseAll') {
      await captureMemory(requestId, 'before_release_all', { force: true });
      await releaseAllLlama();
      activeContext = null;
      activeModelId = null;
      activeModelPath = null;
      activeParams = null;
      streamCallbacks = 0;
      emit(requestId, 'result', { released: true });
      return;
    }

    throw new Error(`未知推理进程命令：${type}`);
  } catch (error) {
    await captureMemory(requestId, 'command_error', { force: true });
    emit(requestId, 'error', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function inferenceWorkerTask(): Promise<never> {
  WorkerBridge.ready();
  while (true) {
    const raw = await WorkerBridge.waitForCommand();
    await handleCommand(raw);
  }
}
