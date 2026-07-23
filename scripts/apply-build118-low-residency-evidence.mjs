import fs from 'node:fs';

function replaceRequired(file, from, to) {
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    if (before.includes(to)) return;
    throw new Error(`[build118] required pattern missing in ${file}`);
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

const settingsPath = 'app/(tabs)/settings.tsx';
replaceRequired(
  settingsPath,
  `  Alert,\n  ScrollView,`,
  `  Alert,\n  Share,\n  ScrollView,`
);
replaceRequired(
  settingsPath,
  `  getLatestInferenceDiagnostic,\n  getPreviousExitInfo,`,
  `  getInferenceDiagnosticLog,\n  getLatestInferenceDiagnostic,\n  getPreviousExitInfo,`
);

const brokenPreset = `  const applyHyperOsLowResidencyPreset = useCallback(() => {
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
  }, [activeModel, inferenceParams, reloadWithParams, setInferenceParams]);`;

const fixedPreset = `  const applyHyperOsLowResidencyPreset = useCallback(() => {
    const preset: InferenceParams = {
      ...inferenceParams,
      // Build117 accidentally restored q8_0 V cache here after the isolated-process
      // compatibility fix had required F16. Keep every known-working model setting
      // unchanged and only enable the diagnostic experiment.
      cache_type_v: 'f16',
      memory_diagnostics_enabled: true,
      memory_diagnostics_interval_tokens: 16,
      low_residency_enabled: true,
      low_residency_interval_tokens: 128,
    };

    const save = () => setInferenceParams(preset);
    if (!activeModel) {
      save();
      Alert.alert(
        '实验模式已保存',
        '下次加载模型时仅开启低驻留与内存日志；不会修改上下文、batch、ubatch 或 K 缓存。V 缓存使用兼容的 F16。'
      );
      return;
    }

    Alert.alert(
      '开启 HyperOS 低驻留实验',
      '只开启推理日志和页缓存回收实验，不再改动当前可正常加载模型的上下文、batch、ubatch、K 缓存等参数。为避免已知加载失败，V 缓存固定为 F16。已加载模型需要重新加载。',
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
  }, [activeModel, inferenceParams, reloadWithParams, setInferenceParams]);`;
replaceRequired(settingsPath, brokenPreset, fixedPreset);

replaceRequired(
  settingsPath,
  `  const handleClearDiagnostics = useCallback(() => {`,
  `  const handleShareDiagnostics = useCallback(() => {
    void getInferenceDiagnosticLog()
      .then(async (log) => {
        if (!log.trim()) {
          Alert.alert('暂无日志', '请先加载模型并至少运行一次生成，然后刷新诊断。');
          return;
        }
        await Share.share({
          title: '推理进程内存日志',
          message: log,
        });
      })
      .catch((error) => Alert.alert('分享失败', error instanceof Error ? error.message : '未知错误'));
  }, []);

  const handleClearDiagnostics = useCallback(() => {`
);

replaceRequired(
  settingsPath,
  `          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.error }]}
            onPress={handleClearDiagnostics}`,
  `          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.primary }]}
            onPress={handleShareDiagnostics}
            accessible
            accessibilityRole="button"
            accessibilityLabel="分享完整推理进程内存日志"
            accessibilityHint="打开系统分享面板，可发送或复制全部 JSONL 采样"
          >
            <Text style={{ color: colors.primary }}>分享完整推理日志</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.error }]}
            onPress={handleClearDiagnostics}`
);

const workerPath = 'lib/services/inference-worker.ts';
replaceRequired(
  workerPath,
  `let streamCallbacks = 0;\nlet diagnosticBusy = false;`,
  `let streamCallbacks = 0;\nlet diagnosticBusy = false;\nlet cacheDropBusy = false;`
);

const oldStreamFunction = `function maybeCaptureDuringStream(requestId: string): void {
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
}`;

const newStreamFunction = `async function performLowResidencyDrop(requestId: string, stage: string): Promise<void> {
  const params = activeParams;
  if (!params?.low_residency_enabled || !activeModelPath || cacheDropBusy) return;

  cacheDropBusy = true;
  try {
    // Record both sides of the same operation so a device test can show whether
    // file-backed PSS actually falls, instead of merely confirming that JNI ran.
    await captureMemory(requestId, \`${'${stage}'}_before_cache_drop\`, { force: true });
    let cacheDropResult: CacheDropResult;
    try {
      cacheDropResult = await WorkerBridge.dropFileCache(activeModelPath);
    } catch (error) {
      cacheDropResult = {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    await captureMemory(requestId, \`${'${stage}'}_after_cache_drop\`, {
      force: true,
      cacheDropAttempted: true,
      cacheDropResult,
    });
  } finally {
    cacheDropBusy = false;
  }
}

function maybeCaptureDuringStream(requestId: string): void {
  const params = activeParams;
  if (!params) return;

  const diagnosticInterval = Math.max(16, params.memory_diagnostics_interval_tokens || 64);
  const lowResidencyInterval = Math.max(64, params.low_residency_interval_tokens || 128);
  const shouldDiagnose = params.memory_diagnostics_enabled && streamCallbacks % diagnosticInterval === 0;
  const shouldDrop = params.low_residency_enabled
    && Boolean(activeModelPath)
    && !cacheDropBusy
    && streamCallbacks >= lowResidencyInterval
    && streamCallbacks % lowResidencyInterval === 0;

  if (shouldDrop) {
    void performLowResidencyDrop(requestId, 'stream');
    return;
  }
  if (shouldDiagnose) void captureMemory(requestId, 'stream');
}`;
replaceRequired(workerPath, oldStreamFunction, newStreamFunction);
replaceRequired(
  workerPath,
  `      activeParams = command.params as unknown as InferenceParams;\n      streamCallbacks = 0;`,
  `      activeParams = command.params as unknown as InferenceParams;\n      streamCallbacks = 0;\n      cacheDropBusy = false;`
);
replaceRequired(
  workerPath,
  `      await captureMemory(requestId, 'completion_end', { force: true });\n      emit(requestId, 'result', result);`,
  `      if (activeParams?.low_residency_enabled) {
        await performLowResidencyDrop(requestId, 'completion_end');
      }
      await captureMemory(requestId, 'completion_end', { force: true });
      emit(requestId, 'result', result);`
);
let worker = fs.readFileSync(workerPath, 'utf8');
worker = worker.replaceAll(
  `      streamCallbacks = 0;\n      emit(requestId, 'result', { released: true });`,
  `      streamCallbacks = 0;\n      cacheDropBusy = false;\n      emit(requestId, 'result', { released: true });`
);
fs.writeFileSync(workerPath, worker, 'utf8');

const runtimePath = 'lib/services/runtime-memory.ts';
replaceRequired(
  runtimePath,
  `export interface PreviousExitInfo {\n  reason: string;`,
  `export interface PreviousExitInfo {\n  processName: string;\n  isInferenceProcess: boolean;\n  reason: string;`
);
replaceRequired(
  runtimePath,
  `  getLatestInferenceDiagnostic(): Promise<string | null>;\n  clearInferenceDiagnosticLog(): Promise<void>;`,
  `  getLatestInferenceDiagnostic(): Promise<string | null>;\n  getInferenceDiagnosticLog(): Promise<string>;\n  clearInferenceDiagnosticLog(): Promise<void>;`
);
replaceRequired(
  runtimePath,
  `export async function clearInferenceDiagnosticLog(): Promise<void> {`,
  `export async function getInferenceDiagnosticLog(): Promise<string> {
  if (Platform.OS !== 'android' || !nativeModule) return '';
  return nativeModule.getInferenceDiagnosticLog();
}

export async function clearInferenceDiagnosticLog(): Promise<void> {`
);
replaceRequired(
  runtimePath,
  `export function describePreviousExit(info: PreviousExitInfo): string {
  const memory = info.rssMb > 0 || info.pssMb > 0
    ? \`，退出前 RSS ${'${info.rssMb.toFixed(0)}'} MB，PSS ${'${info.pssMb.toFixed(0)}'} MB\`
    : '';
  const detail = info.description ? \`，${'${info.description}'}\` : '';
  return \`上一次进程退出原因：${'${info.reason}'}${'${memory}'}${'${detail}'}\`;
}`,
  `export function describePreviousExit(info: PreviousExitInfo): string {
  const memory = info.rssMb > 0 || info.pssMb > 0
    ? \`，退出前 RSS ${'${info.rssMb.toFixed(0)}'} MB，PSS ${'${info.pssMb.toFixed(0)}'} MB\`
    : '';
  const detail = info.description ? \`，${'${info.description}'}\` : '';
  const target = info.isInferenceProcess
    ? \`上一次推理进程 ${'${info.processName}'}\`
    : \`未找到推理进程退出记录；最近记录来自 ${'${info.processName || \'未知进程\'}'}\`;
  return \`${'${target}'}，退出原因：${'${info.reason}'}${'${memory}'}${'${detail}'}\`;
}`
);
replaceRequired(
  runtimePath,
  `  const cacheDrop = info.cacheDropAttempted
    ? \`；页缓存回收提示${'${info.cacheDropSuccess ? \'已执行\' : \'失败\'}'}\`
    : '';
  return \`推理进程 ${'${info.processName || info.pid}'}，阶段 ${'${info.stage}'}，token 回调 ${'${info.tokenCallbacks}'}；总 PSS ${'${info.totalPssMb.toFixed(0)}'} MB，其中文件映射 ${'${info.pssFileMb.toFixed(0)}'} MB、匿名内存 ${'${info.pssAnonMb.toFixed(0)}'} MB、共享内存 ${'${info.pssShmemMb.toFixed(0)}'} MB；RSS ${'${info.rssMb.toFixed(0)}'} MB，SwapPss ${'${info.swapPssMb.toFixed(0)}'} MB，系统可用 ${'${info.availMemMb.toFixed(0)}'} MB${'${cacheDrop}'}。\`;`,
  `  const mode = info.lowResidencyEnabled ? '；低驻留实验已开启' : '；低驻留实验未开启';
  const cacheDrop = info.cacheDropAttempted
    ? \`；页缓存回收${'${info.cacheDropSuccess ? \'已执行\' : \'失败\'}'}${'${info.cacheDropMessage ? `（${info.cacheDropMessage}）` : \'\'}'}\`
    : '';
  return \`推理进程 ${'${info.processName || info.pid}'}，阶段 ${'${info.stage}'}，token 回调 ${'${info.tokenCallbacks}'}；总 PSS ${'${info.totalPssMb.toFixed(0)}'} MB，其中文件映射 ${'${info.pssFileMb.toFixed(0)}'} MB、匿名内存 ${'${info.pssAnonMb.toFixed(0)}'} MB、共享内存 ${'${info.pssShmemMb.toFixed(0)}'} MB；RSS ${'${info.rssMb.toFixed(0)}'} MB，SwapPss ${'${info.swapPssMb.toFixed(0)}'} MB，系统可用 ${'${info.availMemMb.toFixed(0)}'} MB${'${mode}'}${'${cacheDrop}'}。\`;`
);

for (const [file, required] of [
  [settingsPath, ['Share.share', "cache_type_v: 'f16'", 'low_residency_interval_tokens: 128', '分享完整推理日志']],
  [workerPath, ['performLowResidencyDrop', 'stream_before_cache_drop', 'cacheDropBusy']],
  [runtimePath, ['getInferenceDiagnosticLog', 'isInferenceProcess', '未找到推理进程退出记录']],
]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of required) {
    if (!text.includes(marker)) throw new Error(`[build118] invariant missing in ${file}: ${marker}`);
  }
}

console.log('[build118] low-residency preset repaired and complete diagnostics sharing prepared');
