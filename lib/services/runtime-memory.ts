import { NativeModules, Platform } from 'react-native';

export interface RuntimeMemorySnapshot {
  totalMemMb: number;
  availMemMb: number;
  thresholdMb: number;
  lowMemory: boolean;
  totalPssMb: number;
  nativeHeapAllocatedMb: number;
  nativeHeapSizeMb: number;
}

export interface PreviousExitInfo {
  reason: string;
  description: string;
  timestamp: number;
  pssMb: number;
  rssMb: number;
  status: number;
  importance: number;
}

export interface InferenceMemoryDiagnostic {
  timestamp: number;
  stage: string;
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
  tokenCallbacks: number;
  modelId?: string | null;
  modelPath?: string | null;
  lowResidencyEnabled?: boolean;
  cacheDropAttempted?: boolean;
  cacheDropSuccess?: boolean | null;
  cacheDropMessage?: string | null;
}

interface RuntimeMemoryNativeModule {
  getSnapshot(): Promise<RuntimeMemorySnapshot>;
  getPreviousExit(): Promise<PreviousExitInfo | null>;
  getLatestInferenceDiagnostic(): Promise<string | null>;
  clearInferenceDiagnosticLog(): Promise<void>;
}

const nativeModule = NativeModules.RuntimeMemory as RuntimeMemoryNativeModule | undefined;

export async function getRuntimeMemorySnapshot(): Promise<RuntimeMemorySnapshot | null> {
  if (Platform.OS !== 'android' || !nativeModule) return null;
  return nativeModule.getSnapshot();
}

export async function getPreviousExitInfo(): Promise<PreviousExitInfo | null> {
  if (Platform.OS !== 'android' || !nativeModule) return null;
  return nativeModule.getPreviousExit();
}

export async function getLatestInferenceDiagnostic(): Promise<InferenceMemoryDiagnostic | null> {
  if (Platform.OS !== 'android' || !nativeModule) return null;
  const raw = await nativeModule.getLatestInferenceDiagnostic();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InferenceMemoryDiagnostic;
  } catch {
    return null;
  }
}

export async function clearInferenceDiagnosticLog(): Promise<void> {
  if (Platform.OS !== 'android' || !nativeModule) return;
  await nativeModule.clearInferenceDiagnosticLog();
}

export function describePreviousExit(info: PreviousExitInfo): string {
  const memory = info.rssMb > 0 || info.pssMb > 0
    ? `，退出前 RSS ${info.rssMb.toFixed(0)} MB，PSS ${info.pssMb.toFixed(0)} MB`
    : '';
  const detail = info.description ? `，${info.description}` : '';
  return `上一次进程退出原因：${info.reason}${memory}${detail}`;
}

export function describeInferenceDiagnostic(info: InferenceMemoryDiagnostic): string {
  const cacheDrop = info.cacheDropAttempted
    ? `；页缓存回收提示${info.cacheDropSuccess ? '已执行' : '失败'}`
    : '';
  return `推理进程 ${info.processName || info.pid}，阶段 ${info.stage}，token 回调 ${info.tokenCallbacks}；总 PSS ${info.totalPssMb.toFixed(0)} MB，其中文件映射 ${info.pssFileMb.toFixed(0)} MB、匿名内存 ${info.pssAnonMb.toFixed(0)} MB、共享内存 ${info.pssShmemMb.toFixed(0)} MB；RSS ${info.rssMb.toFixed(0)} MB，SwapPss ${info.swapPssMb.toFixed(0)} MB，系统可用 ${info.availMemMb.toFixed(0)} MB${cacheDrop}。`;
}
