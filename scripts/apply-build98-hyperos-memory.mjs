import fs from 'node:fs';

function replaceRequired(file, from, to) {
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    if (before.includes(to)) return;
    throw new Error(`[build98] required pattern missing in ${file}`);
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

const typesPath = 'lib/types.ts';
let types = fs.readFileSync(typesPath, 'utf8');
types = types.replace(
  `  memory_guard_enabled: boolean;
  memory_guard_reserve_mb: number;
  temperature: number;`,
  `  memory_guard_enabled: boolean;
  memory_guard_reserve_mb: number;
  memory_diagnostics_enabled: boolean;
  memory_diagnostics_interval_tokens: number;
  low_residency_enabled: boolean;
  low_residency_interval_tokens: number;
  temperature: number;`
);
types = types.replace(
  `  memory_guard_enabled: true,
  memory_guard_reserve_mb: 1024,
  temperature: 0.7,`,
  `  memory_guard_enabled: true,
  memory_guard_reserve_mb: 1024,
  memory_diagnostics_enabled: true,
  memory_diagnostics_interval_tokens: 64,
  low_residency_enabled: false,
  low_residency_interval_tokens: 64,
  temperature: 0.7,`
);
if (!types.includes('low_residency_enabled')) {
  throw new Error('[build98] inference parameter extension failed');
}
fs.writeFileSync(typesPath, types, 'utf8');

const workerSource = `import { NativeModules } from 'react-native';
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
`;
fs.writeFileSync('lib/services/inference-worker.ts', workerSource, 'utf8');

const runtimeMemorySource = `import { NativeModules, Platform } from 'react-native';

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
`;
fs.writeFileSync('lib/services/runtime-memory.ts', runtimeMemorySource, 'utf8');

const settingsPath = 'app/(tabs)/settings.tsx';
replaceRequired(
  settingsPath,
  `  describePreviousExit,
  getPreviousExitInfo,
  getRuntimeMemorySnapshot,
  PreviousExitInfo,
  RuntimeMemorySnapshot,`,
  `  clearInferenceDiagnosticLog,
  describeInferenceDiagnostic,
  describePreviousExit,
  getLatestInferenceDiagnostic,
  getPreviousExitInfo,
  getRuntimeMemorySnapshot,
  InferenceMemoryDiagnostic,
  PreviousExitInfo,
  RuntimeMemorySnapshot,`
);

replaceRequired(
  settingsPath,
  `  const [previousExit, setPreviousExit] = useState<PreviousExitInfo | null>(null);
  const [reloading, setReloading] = useState(false);`,
  `  const [previousExit, setPreviousExit] = useState<PreviousExitInfo | null>(null);
  const [inferenceDiagnostic, setInferenceDiagnostic] = useState<InferenceMemoryDiagnostic | null>(null);
  const [reloading, setReloading] = useState(false);`
);

replaceRequired(
  settingsPath,
  `    void getRuntimeMemorySnapshot().then(setMemory).catch(() => setMemory(null));
    void getPreviousExitInfo().then(setPreviousExit).catch(() => setPreviousExit(null));`,
  `    void getRuntimeMemorySnapshot().then(setMemory).catch(() => setMemory(null));
    void getPreviousExitInfo().then(setPreviousExit).catch(() => setPreviousExit(null));
    void getLatestInferenceDiagnostic().then(setInferenceDiagnostic).catch(() => setInferenceDiagnostic(null));`
);

replaceRequired(
  settingsPath,
  `      memory_guard_enabled: true,
      memory_guard_reserve_mb: 1536,
      max_tokens: Math.min(inferenceParams.max_tokens, 1024),`,
  `      memory_guard_enabled: true,
      memory_guard_reserve_mb: 1536,
      memory_diagnostics_enabled: true,
      memory_diagnostics_interval_tokens: 64,
      low_residency_enabled: false,
      low_residency_interval_tokens: 64,
      max_tokens: Math.min(inferenceParams.max_tokens, 1024),`
);

replaceRequired(
  settingsPath,
  `  const handleReset = useCallback(() => {`,
  `  const applyHyperOsLowResidencyPreset = useCallback(() => {
    const preset: InferenceParams = {
      ...inferenceParams,
      n_batch: 32,
      n_ubatch: 16,
      use_mmap: true,
      use_mlock: false,
      no_extra_bufts: true,
      cache_type_k: 'q8_0',
      cache_type_v: 'q8_0',
      memory_diagnostics_enabled: true,
      memory_diagnostics_interval_tokens: 32,
      low_residency_enabled: true,
      low_residency_interval_tokens: 32,
    };

    const save = () => setInferenceParams(preset);
    if (!activeModel) {
      save();
      Alert.alert('实验预设已保存', '下次加载模型时会启用低驻留实验，并每 32 个 token 回调记录一次推理进程内存。');
      return;
    }

    Alert.alert(
      '应用 HyperOS 低驻留实验预设',
      '该模式会保持 mmap，降低 batch，并周期性对 GGUF 文件页缓存发出 DONTNEED 回收提示。可能明显降低速度，但用于验证是否能压低 Pss_File。已加载模型必须重新加载。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '仅保存，稍后重载',
          onPress: () => {
            save();
            Alert.alert('已保存', '请稍后卸载并重新加载模型。');
          },
        },
        {
          text: '保存并立即重新加载',
          onPress: () => {
            save();
            void reloadWithParams(preset);
          },
        },
      ]
    );
  }, [activeModel, inferenceParams, reloadWithParams, setInferenceParams]);

  const handleClearDiagnostics = useCallback(() => {
    Alert.alert('清空推理内存日志', '确定删除当前保存的推理进程内存采样吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: () => {
          void clearInferenceDiagnosticLog()
            .then(() => setInferenceDiagnostic(null))
            .catch((error) => Alert.alert('清空失败', error instanceof Error ? error.message : '未知错误'));
        },
      },
    ]);
  }, []);

  const handleReset = useCallback(() => {`
);

replaceRequired(
  settingsPath,
  `          <Text style={[styles.cardDesc, { color: colors.muted }]} accessible accessibilityRole="text">
            {previousExit ? describePreviousExit(previousExit) : '没有读取到上一轮异常退出记录。'}
          </Text>
          <TouchableOpacity`,
  `          <Text style={[styles.cardDesc, { color: colors.muted }]} accessible accessibilityRole="text">
            {previousExit ? describePreviousExit(previousExit) : '没有读取到上一轮异常退出记录。'}
          </Text>
          <Text style={[styles.cardDesc, { color: colors.muted }]} accessible accessibilityRole="text">
            {inferenceDiagnostic
              ? describeInferenceDiagnostic(inferenceDiagnostic)
              : '尚未读取到推理进程内存采样。加载模型或开始生成后再刷新。'}
          </Text>
          <TouchableOpacity`
);

replaceRequired(
  settingsPath,
  `          </TouchableOpacity>
        </View>

        {activeModel && (`,
  `          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.error }]}
            onPress={handleClearDiagnostics}
            accessible
            accessibilityRole="button"
            accessibilityLabel="清空推理进程内存诊断日志"
          >
            <Text style={{ color: colors.error }}>清空推理内存日志</Text>
          </TouchableOpacity>
        </View>

        {activeModel && (`
);

replaceRequired(
  settingsPath,
  `        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>`,
  `        <TouchableOpacity
          style={[styles.presetBtn, { borderColor: colors.warning }]}
          onPress={applyHyperOsLowResidencyPreset}
          disabled={reloading}
          accessible
          accessibilityRole="button"
          accessibilityLabel="应用 HyperOS 低驻留实验预设"
          accessibilityHint="周期性回收 GGUF 文件页缓存并记录推理进程 PSS 组成"
        >
          <Text style={[styles.presetBtnText, { color: colors.warning }]}>HyperOS 低驻留实验预设</Text>
        </TouchableOpacity>

        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>`
);

replaceRequired(
  settingsPath,
  `          <ToggleRow label="生成时监测系统内存" description="接近系统低内存阈值时主动停止并保留已输出内容；不能保证阻止所有原生崩溃" value={params.memory_guard_enabled} onChange={(value) => update('memory_guard_enabled', value)} colors={colors} />
          <ParamRow label="安全保留内存 MB" description="系统可用内存低于此值时停止生成" value={params.memory_guard_reserve_mb} min={256} max={8192} step={256} onChange={(value) => update('memory_guard_reserve_mb', value)} colors={colors} />`,
  `          <ToggleRow label="生成时监测系统内存" description="接近系统低内存阈值时主动停止并保留已输出内容；不能保证阻止所有原生崩溃" value={params.memory_guard_enabled} onChange={(value) => update('memory_guard_enabled', value)} colors={colors} />
          <ParamRow label="安全保留内存 MB" description="系统可用内存低于此值时停止生成" value={params.memory_guard_reserve_mb} min={256} max={8192} step={256} onChange={(value) => update('memory_guard_reserve_mb', value)} colors={colors} />
          <ToggleRow label="记录推理进程 PSS 组成" description="把 Pss_File、Pss_Anon、RSS 和 SwapPss 持续写入本地日志，系统强杀后仍可读取最后采样" value={params.memory_diagnostics_enabled} onChange={(value) => update('memory_diagnostics_enabled', value)} colors={colors} />
          <ParamRow label="诊断采样间隔 token 回调" description="数值越小记录越密集；建议 32 或 64" value={params.memory_diagnostics_interval_tokens} min={16} max={1024} step={16} onChange={(value) => update('memory_diagnostics_interval_tokens', value)} colors={colors} />
          <ToggleRow label="HyperOS 低驻留实验" description="周期性对 GGUF 文件页缓存发出回收提示，可能降低速度；默认关闭" value={params.low_residency_enabled} onChange={(value) => update('low_residency_enabled', value)} colors={colors} />
          <ParamRow label="页缓存回收间隔 token 回调" description="实验模式下每隔多少 token 回调执行一次；建议 32 或 64" value={params.low_residency_interval_tokens} min={16} max={1024} step={16} onChange={(value) => update('low_residency_interval_tokens', value)} colors={colors} />`
);

const settings = fs.readFileSync(settingsPath, 'utf8');
for (const required of [
  'HyperOS 低驻留实验预设',
  'getLatestInferenceDiagnostic',
  'memory_diagnostics_interval_tokens',
  'low_residency_enabled',
]) {
  if (!settings.includes(required)) throw new Error(`[build98] settings invariant missing: ${required}`);
}

console.log('[build98] HyperOS memory diagnostics and low-residency experiment prepared');
