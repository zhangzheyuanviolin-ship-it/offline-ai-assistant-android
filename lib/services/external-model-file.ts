import { NativeModules, Platform } from 'react-native';

export interface ExternalModelResolveResult {
  path: string;
  size: number;
  seekable: boolean;
  persisted: boolean;
  direct: boolean;
}

interface ExternalModelFileNativeModule {
  resolve(uri: string): Promise<ExternalModelResolveResult>;
  open(uri: string): Promise<ExternalModelResolveResult>;
  close(uri: string): Promise<void>;
  closeAll(): Promise<void>;
  hasAllFilesAccess(): Promise<boolean>;
  requestAllFilesAccess(): Promise<boolean>;
}

const nativeModule = NativeModules.ExternalModelFile as ExternalModelFileNativeModule | undefined;

export async function hasDirectModelFileAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (!nativeModule) return false;
  return nativeModule.hasAllFilesAccess();
}

export async function requestDirectModelFileAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (!nativeModule) throw new Error('外部模型路径解析模块未加载');
  return nativeModule.requestAllFilesAccess();
}

export async function resolveExternalModelUri(uri: string): Promise<ExternalModelResolveResult> {
  if (uri.startsWith('file://')) {
    return { path: uri, size: -1, seekable: true, persisted: true, direct: true };
  }
  if (!uri.startsWith('content://')) {
    return { path: uri, size: -1, seekable: true, persisted: true, direct: true };
  }
  if (Platform.OS !== 'android') {
    throw new Error('当前平台不支持直接使用 content URI，请使用复制导入');
  }
  if (!nativeModule) {
    throw new Error('外部模型路径解析模块未加载，请安装包含原生桥接的完整版本');
  }
  const result = await nativeModule.resolve(uri);
  if (!result?.path || !result.seekable || !result.direct) {
    throw new Error('该文件来源不能解析为可供 llama.rn mmap 的真实文件路径，请使用复制导入');
  }
  return result;
}

export async function openExternalModelUri(uri: string): Promise<ExternalModelResolveResult> {
  return resolveExternalModelUri(uri);
}

export async function closeExternalModelUri(uri?: string): Promise<void> {
  if (!uri?.startsWith('content://') || !nativeModule) return;
  await nativeModule.close(uri).catch(() => {});
}

export async function closeAllExternalModelUris(): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.closeAll().catch(() => {});
}
