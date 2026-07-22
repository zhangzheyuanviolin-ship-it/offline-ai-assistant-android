import { NativeModules } from 'react-native';
import { initLlama, releaseAllLlama, type LlamaContext } from 'llama.rn';
import type { InferenceParams } from '../types';

const WorkerBridge = NativeModules.InferenceWorkerBridge as {
  emit(requestId: string, type: string, payloadJson: string): void;
  ready(): void;
  waitForCommand(): Promise<string>;
};

let activeContext: LlamaContext | null = null;
let activeModelId: string | null = null;

function emit(requestId: string, type: string, payload: unknown): void {
  WorkerBridge.emit(requestId, type, JSON.stringify(payload ?? null));
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
      const params = command.params as unknown as InferenceParams;
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
      activeModelId = command.modelId ?? null;
      emit(requestId, 'result', { loaded: true, modelId: activeModelId });
      return;
    }

    if (type === 'completion') {
      if (!activeContext) throw new Error('独立推理进程中没有已加载模型');
      const result = await activeContext.completion(
        (command.params ?? {}) as Parameters<LlamaContext['completion']>[0],
        (data) => emit(requestId, 'stream', data)
      );
      emit(requestId, 'result', result);
      return;
    }

    if (type === 'stop') {
      if (activeContext) await activeContext.stopCompletion();
      emit(requestId, 'result', { stopped: true });
      return;
    }

    if (type === 'release') {
      if (activeContext) await activeContext.release();
      activeContext = null;
      activeModelId = null;
      emit(requestId, 'result', { released: true });
      return;
    }

    if (type === 'releaseAll') {
      await releaseAllLlama();
      activeContext = null;
      activeModelId = null;
      emit(requestId, 'result', { released: true });
      return;
    }

    throw new Error(`未知推理进程命令：${type}`);
  } catch (error) {
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
