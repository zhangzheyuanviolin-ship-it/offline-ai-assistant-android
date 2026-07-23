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

interface RuntimeMemoryNativeModule {
  getSnapshot(): Promise<RuntimeMemorySnapshot>;
  getPreviousExit(): Promise<PreviousExitInfo | null>;
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

export function describePreviousExit(info: PreviousExitInfo): string {
  const memory = info.rssMb > 0 || info.pssMb > 0
    ? `，退出前 RSS ${info.rssMb.toFixed(0)} MB，PSS ${info.pssMb.toFixed(0)} MB`
    : '';
  const detail = info.description ? `，${info.description}` : '';
  return `上一次进程退出原因：${info.reason}${memory}${detail}`;
}
