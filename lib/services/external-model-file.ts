import { NativeModules, Platform } from 'react-native';

interface ExternalModelOpenResult {
  path: string;
  size: number;
  seekable: boolean;
  persisted: boolean;
}

interface ExternalModelFileNativeModule {
  open(uri: string): Promise<ExternalModelOpenResult>;
  close(uri: string): Promise<void>;
  closeAll(): Promise<void>;
}

const nativeModule = NativeModules.ExternalModelFile as ExternalModelFileNativeModule | undefined;

export async function openExternalModelUri(uri: string): Promise<ExternalModelOpenResult> {
  if (uri.startsWith('file://')) {
    return { path: uri, size: -1, seekable: true, persisted: true };
  }
  if (!uri.startsWith('content://')) {
    return { path: uri, size: -1, seekable: true, persisted: true };
  }
  if (Platform.OS !== 'android') {
    throw new Error('当前平台暂不支持直接引用 content URI，请改用复制导入');
  }
  if (!nativeModule) {
    throw new Error('外部模型文件桥接模块未加载，请重新安装完整构建版本');
  }
  const result = await nativeModule.open(uri);
  if (!result?.path || !result.seekable) {
    throw new Error('该文件提供方不支持随机读取或内存映射，请改用复制导入');
  }
  return result;
}

export async function closeExternalModelUri(uri?: string): Promise<void> {
  if (!uri?.startsWith('content://') || !nativeModule) return;
  await nativeModule.close(uri).catch(() => {});
}

export async function closeAllExternalModelUris(): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.closeAll().catch(() => {});
}
