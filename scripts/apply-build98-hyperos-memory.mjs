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

console.log('[build98] HyperOS memory diagnostics UI and parameters prepared');
