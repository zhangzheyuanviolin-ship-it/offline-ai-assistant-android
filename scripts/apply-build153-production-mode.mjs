import fs from 'node:fs';

function requireText(file, marker) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(marker)) {
    throw new Error(`[build153-source] missing marker in ${file}: ${marker}`);
  }
  return text;
}

function replaceRequired(file, from, to) {
  const before = requireText(file, from);
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

const typesPath = 'lib/types.ts';
let types = fs.readFileSync(typesPath, 'utf8');
types = types.replace('  memory_diagnostics_enabled: true,', '  memory_diagnostics_enabled: false,');
types = types.replace('  memory_diagnostics_interval_tokens: 64,', '  memory_diagnostics_interval_tokens: 256,');
types = types.replace('  low_residency_interval_tokens: 64,', '  low_residency_interval_tokens: 1024,');
if (!types.includes('memory_diagnostics_enabled: false')) {
  throw new Error('[build153-source] failed to disable default diagnostics');
}
fs.writeFileSync(typesPath, types, 'utf8');

const storePath = 'lib/store.ts';
replaceRequired(
  storePath,
  `        const inferenceParams: InferenceParams = {
          ...DEFAULT_INFERENCE_PARAMS,
          ...storedParams,
        };`,
  `        // Build153 intentionally migrates every prior diagnostic/low-residency
        // experiment back to the production path. Old Build117/152 settings must
        // not keep running expensive smaps scans or DONTNEED calls after upgrade.
        const inferenceParams: InferenceParams = {
          ...DEFAULT_INFERENCE_PARAMS,
          ...storedParams,
          cache_type_v: 'f16',
          memory_diagnostics_enabled: false,
          memory_diagnostics_interval_tokens: 256,
          low_residency_enabled: false,
          low_residency_interval_tokens: 1024,
        };
        AsyncStorage.setItem('inferenceParams', JSON.stringify(inferenceParams)).catch(() => {});`
);

const workerPath = 'lib/services/inference-worker.ts';
let worker = fs.readFileSync(workerPath, 'utf8');
const captureStart = worker.indexOf('async function captureMemory(');
const lowResidencyStart = worker.indexOf('async function performLowResidencyDrop(', captureStart);
const streamStart = worker.indexOf('function maybeCaptureDuringStream(', lowResidencyStart);
const commandStart = worker.indexOf('async function handleCommand(', streamStart);
if ([captureStart, lowResidencyStart, streamStart, commandStart].some((value) => value < 0)) {
  throw new Error('[build153-source] inference diagnostic function boundaries not found');
}
const noDiagnostics = `async function captureMemory(
  requestId: string,
  stage: string,
  options: {
    force?: boolean;
    cacheDropAttempted?: boolean;
    cacheDropResult?: CacheDropResult | null;
  } = {}
): Promise<void> {
  // Build153 production path: reading /proc/self/smaps_rollup and appending JSONL
  // during generation caused visible multi-second stalls. Keep the callable
  // surface for compatibility, but perform no sampling in the inference loop.
  void requestId;
  void stage;
  void options;
}

async function performLowResidencyDrop(requestId: string, stage: string): Promise<void> {
  // The Build103/118 periodic DONTNEED experiment is retired. Demand paging is
  // now implemented inside the custom llama.cpp mmap loader before inference.
  void requestId;
  void stage;
}

function maybeCaptureDuringStream(requestId: string): void {
  void requestId;
}

`;
worker = worker.slice(0, captureStart) + noDiagnostics + worker.slice(commandStart);
if (!worker.includes('Build153 production path') || !worker.includes('async function handleCommand(')) {
  throw new Error('[build153-source] failed to replace inference diagnostics');
}
fs.writeFileSync(workerPath, worker, 'utf8');

const settingsPath = 'app/(tabs)/settings.tsx';
let settings = fs.readFileSync(settingsPath, 'utf8');
const presetStart = settings.indexOf('  const applyHyperOsLowResidencyPreset = useCallback(() => {');
const presetEndMarker = '  const handleShareDiagnostics = useCallback(() => {';
const presetEnd = settings.indexOf(presetEndMarker, presetStart);
if (presetStart < 0 || presetEnd < 0) {
  throw new Error('[build153-source] HyperOS preset block not found');
}
const stablePreset = `  const applyHyperOsLowResidencyPreset = useCallback(() => {
    const preset: InferenceParams = {
      ...inferenceParams,
      cache_type_v: 'f16',
      memory_diagnostics_enabled: false,
      memory_diagnostics_interval_tokens: 256,
      low_residency_enabled: false,
      low_residency_interval_tokens: 1024,
    };

    const save = () => setInferenceParams(preset);
    if (!activeModel) {
      save();
      Alert.alert(
        '稳定模式已保存',
        '底层定制引擎会自动使用 MoE 按需分页，并停用逐 token 内存扫描和旧版周期回收。下次加载模型时生效。'
      );
      return;
    }

    Alert.alert(
      '应用 HyperOS 30B MoE 稳定模式',
      '该模式保留当前上下文、batch、ubatch 和 K 缓存，只固定兼容的 F16 V 缓存；底层引擎自动关闭整文件预填充并按需读取专家权重。已加载模型需要重新加载。',
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

`;
settings = settings.slice(0, presetStart) + stablePreset + settings.slice(presetEnd);
settings = settings
  .replaceAll('HyperOS 低驻留实验预设', 'HyperOS 30B MoE 稳定模式')
  .replace(
    '周期性回收 GGUF 文件页缓存并记录推理进程 PSS 组成',
    '关闭整文件预填充，使用定制 llama.cpp 对 MoE 专家权重按需分页'
  );

const legacyRows = /\s*<ToggleRow label="记录推理进程 PSS 组成"[\s\S]*?<ParamRow label="页缓存回收间隔 token 回调"[^\n]*\/>/;
if (legacyRows.test(settings)) {
  settings = settings.replace(
    legacyRows,
    `
          <Text style={[styles.cardDesc, { color: colors.muted }]} accessible accessibilityRole="text">
            Build153 已停用逐 token PSS 扫描和旧版 DONTNEED 回收。MoE 按需分页由定制原生引擎自动执行，无需手动设置采样间隔。
          </Text>`
  );
}

for (const marker of [
  'HyperOS 30B MoE 稳定模式',
  'memory_diagnostics_enabled: false',
  'low_residency_enabled: false',
  'MoE 按需分页',
]) {
  if (!settings.includes(marker)) throw new Error(`[build153-source] settings marker missing: ${marker}`);
}
fs.writeFileSync(settingsPath, settings, 'utf8');

console.log('[build153-source] legacy diagnostics retired; production MoE demand-paging settings prepared');
