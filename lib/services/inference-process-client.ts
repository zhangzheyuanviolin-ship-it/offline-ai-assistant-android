import { NativeEventEmitter, NativeModules } from 'react-native';
import type { LlamaContext } from 'llama.rn';
import type { AIModel, InferenceParams } from '../types';

const NativeInferenceProcess = NativeModules.InferenceProcess as {
  start(): Promise<boolean>;
  send(commandJson: string): Promise<boolean>;
};

interface NativeEvent {
  requestId: string;
  type: 'progress' | 'stream' | 'result' | 'error';
  payload: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onProgress?: (progress: number) => void;
  onStream?: (data: Record<string, unknown>) => void;
}

const pending = new Map<string, PendingRequest>();
let started = false;
let listenerInstalled = false;

function parsePayload(payload: string): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function installListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  const emitter = new NativeEventEmitter(NativeInferenceProcess as never);
  emitter.addListener('OfflineInferenceEvent', (event: NativeEvent) => {
    const request = pending.get(event.requestId);
    if (!request) return;
    const payload = parsePayload(event.payload);
    if (event.type === 'progress') {
      const value = typeof payload === 'object' && payload && 'progress' in payload
        ? Number((payload as { progress: unknown }).progress)
        : Number(payload);
      if (Number.isFinite(value)) request.onProgress?.(value);
      return;
    }
    if (event.type === 'stream') {
      if (payload && typeof payload === 'object') request.onStream?.(payload as Record<string, unknown>);
      return;
    }
    pending.delete(event.requestId);
    if (event.type === 'error') {
      const message = payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : String(payload ?? '独立推理进程发生未知错误');
      request.reject(new Error(message));
      return;
    }
    request.resolve(payload);
  });
}

async function ensureStarted(): Promise<void> {
  installListener();
  if (started) return;
  await NativeInferenceProcess.start();
  started = true;
}

function nextRequestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

async function request(
  command: Record<string, unknown>,
  options: Pick<PendingRequest, 'onProgress' | 'onStream'> = {}
): Promise<unknown> {
  await ensureStarted();
  const requestId = nextRequestId(String(command.type ?? 'request'));
  const promise = new Promise<unknown>((resolve, reject) => {
    pending.set(requestId, { resolve, reject, ...options });
  });
  try {
    await NativeInferenceProcess.send(JSON.stringify({ ...command, requestId }));
  } catch (error) {
    pending.delete(requestId);
    throw error;
  }
  return promise;
}

export async function createRemoteLlamaContext(
  model: AIModel,
  resolvedPath: string,
  params: InferenceParams,
  onProgress?: (progress: number) => void
): Promise<LlamaContext> {
  await request(
    {
      type: 'load',
      modelId: model.id,
      modelPath: resolvedPath,
      params,
    },
    { onProgress }
  );

  const context = {
    completion: async (
      completionParams: Record<string, unknown>,
      callback?: (data: Record<string, unknown>) => void
    ) => request(
      { type: 'completion', params: completionParams },
      { onStream: callback }
    ),
    stopCompletion: async () => {
      await request({ type: 'stop' });
    },
    release: async () => {
      await request({ type: 'release' });
    },
  };

  return context as unknown as LlamaContext;
}

export async function releaseRemoteLlamaAll(): Promise<void> {
  await request({ type: 'releaseAll' });
}
