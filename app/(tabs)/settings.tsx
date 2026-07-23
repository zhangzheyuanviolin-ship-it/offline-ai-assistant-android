import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore, selectActiveModel } from '@/lib/store';
import {
  DEFAULT_INFERENCE_PARAMS,
  InferenceParams,
  KVCacheType,
} from '@/lib/types';
import { loadModel, releaseModel } from '@/lib/services/model-service';
import {
  describePreviousExit,
  getPreviousExitInfo,
  getRuntimeMemorySnapshot,
  PreviousExitInfo,
  RuntimeMemorySnapshot,
} from '@/lib/services/runtime-memory';

interface ParamRowProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (value: number) => void;
  colors: ReturnType<typeof useColors>;
}

function ParamRow({
  label,
  description,
  value,
  min,
  max,
  step,
  decimals = 0,
  onChange,
  colors,
}: ParamRowProps) {
  const format = (number: number) => decimals > 0 ? number.toFixed(decimals) : String(number);
  return (
    <View style={[styles.paramRow, { borderBottomColor: colors.border }]} accessible={false}>
      <View style={styles.paramInfo} accessible={false}>
        <Text style={[styles.paramLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.paramDesc, { color: colors.muted }]}>{description}</Text>
      </View>
      <View style={styles.paramControl} accessible={false}>
        <TouchableOpacity
          style={[styles.stepBtn, { borderColor: colors.border }]}
          onPress={() => onChange(Math.max(min, Number((value - step).toFixed(decimals + 2))))}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`减小 ${label}，当前 ${format(value)}`}
        >
          <Text style={[styles.stepBtnText, { color: colors.foreground }]}>−</Text>
        </TouchableOpacity>
        <View
          style={[styles.valueBox, { borderColor: colors.primary }]}
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${label} 当前值 ${format(value)}`}
        >
          <Text style={[styles.valueText, { color: colors.primary }]}>{format(value)}</Text>
        </View>
        <TouchableOpacity
          style={[styles.stepBtn, { borderColor: colors.border }]}
          onPress={() => onChange(Math.min(max, Number((value + step).toFixed(decimals + 2))))}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`增大 ${label}，当前 ${format(value)}`}
        >
          <Text style={[styles.stepBtnText, { color: colors.foreground }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ToggleRow({
  label,
  description,
  value,
  onChange,
  colors,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.paramRow, { borderBottomColor: colors.border }]} accessible={false}>
      <View style={styles.paramInfo} accessible={false}>
        <Text style={[styles.paramLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.paramDesc, { color: colors.muted }]}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessible
        accessibilityRole="switch"
        accessibilityLabel={`${label}，当前${value ? '开启' : '关闭'}`}
        accessibilityState={{ checked: value }}
      />
    </View>
  );
}

function KVChoice({
  label,
  value,
  onChange,
  colors,
}: {
  label: string;
  value: KVCacheType;
  onChange: (value: KVCacheType) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.choiceRow, { borderBottomColor: colors.border }]} accessible={false}>
      <Text style={[styles.paramLabel, { color: colors.foreground }]}>{label}</Text>
      <View style={styles.choiceButtons} accessible={false}>
        {(['f16', 'q8_0', 'q4_0'] as KVCacheType[]).map((option) => {
          const selected = option === value;
          return (
            <TouchableOpacity
              key={option}
              style={[
                styles.choiceBtn,
                {
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? `${colors.primary}22` : colors.background,
                },
              ]}
              onPress={() => onChange(option)}
              accessible
              accessibilityRole="radio"
              accessibilityLabel={`${label} ${option}`}
              accessibilityState={{ selected }}
            >
              <Text style={{ color: selected ? colors.primary : colors.foreground }}>{option}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const {
    inferenceParams,
    setInferenceParams,
    setActiveModel,
    setModelLoaded,
    activeModelId,
    syncModelLoadedState,
  } = useAppStore();
  const activeModel = useAppStore(selectActiveModel);
  const [memory, setMemory] = useState<RuntimeMemorySnapshot | null>(null);
  const [previousExit, setPreviousExit] = useState<PreviousExitInfo | null>(null);
  const [reloading, setReloading] = useState(false);

  const refreshDiagnostics = useCallback(() => {
    void getRuntimeMemorySnapshot().then(setMemory).catch(() => setMemory(null));
    void getPreviousExitInfo().then(setPreviousExit).catch(() => setPreviousExit(null));
  }, []);

  useEffect(() => {
    refreshDiagnostics();
  }, [refreshDiagnostics]);

  const update = useCallback(
    <K extends keyof InferenceParams,>(key: K, value: InferenceParams[K]) => {
      setInferenceParams({ [key]: value } as Partial<InferenceParams>);
    },
    [setInferenceParams]
  );

  const reloadWithParams = useCallback(async (next: InferenceParams) => {
    if (!activeModel || reloading) return;
    setReloading(true);
    try {
      await releaseModel();
      if (activeModelId) setModelLoaded(activeModelId, false);
      setActiveModel(null);
      await loadModel(activeModel, next);
      setModelLoaded(activeModel.id, true);
      setActiveModel(activeModel.id);
      syncModelLoadedState();
      refreshDiagnostics();
      Alert.alert('重新加载成功', '新参数已经实际传入推理引擎');
    } catch (error) {
      syncModelLoadedState();
      Alert.alert('重新加载失败', error instanceof Error ? error.message : '未知错误');
    } finally {
      setReloading(false);
    }
  }, [
    activeModel,
    activeModelId,
    reloading,
    setActiveModel,
    setModelLoaded,
    syncModelLoadedState,
    refreshDiagnostics,
  ]);

  const applyMoEPreset = useCallback(() => {
    const preset: InferenceParams = {
      ...inferenceParams,
      n_ctx: 2048,
      n_batch: 32,
      n_ubatch: 16,
      n_threads: 4,
      n_gpu_layers: 0,
      use_mmap: true,
      use_mlock: false,
      no_extra_bufts: true,
      cache_type_k: 'q8_0',
      cache_type_v: 'q8_0',
      memory_guard_enabled: true,
      memory_guard_reserve_mb: 1536,
      max_tokens: Math.min(inferenceParams.max_tokens, 1024),
    };

    const save = () => setInferenceParams(preset);
    if (!activeModel) {
      save();
      Alert.alert('预设已保存', '这些参数会在下次加载模型时生效。');
      return;
    }

    Alert.alert(
      '应用 30B MoE 稳定优先预设',
      '该预设会使用上下文 2048、batch 32、ubatch 16、Q8 KV 缓存、mmap、no_extra_bufts 和 1.5 GB 内存保护。已加载模型必须重新加载后才会生效。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '仅保存，稍后重载',
          onPress: () => {
            save();
            Alert.alert('已保存', '当前已加载模型仍在使用旧参数，请稍后卸载并重新加载。');
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

  const handleReset = useCallback(() => {
    Alert.alert('重置参数', '确定恢复默认参数吗？已加载模型需要重新加载才会生效。', [
      { text: '取消', style: 'cancel' },
      { text: '重置', onPress: () => setInferenceParams(DEFAULT_INFERENCE_PARAMS) },
    ]);
  }, [setInferenceParams]);

  const handleUnloadModel = useCallback(() => {
    if (!activeModel) return;
    Alert.alert('卸载模型', `确定卸载“${activeModel.name}”吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '卸载',
        style: 'destructive',
        onPress: async () => {
          await releaseModel();
          if (activeModelId) setModelLoaded(activeModelId, false);
          setActiveModel(null);
          refreshDiagnostics();
        },
      },
    ]);
  }, [activeModel, activeModelId, setActiveModel, setModelLoaded, refreshDiagnostics]);

  const params = inferenceParams;

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.container} accessible={false}>
        <Text style={[styles.title, { color: colors.foreground }]} accessibilityRole="header">推理参数设置</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>参数只在加载模型时生效；修改后需要重新加载。</Text>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} accessible={false}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>运行内存诊断</Text>
          <Text style={[styles.cardDesc, { color: colors.muted }]} accessible accessibilityRole="text">
            {memory
              ? `系统总内存 ${memory.totalMemMb.toFixed(0)} MB，可用 ${memory.availMemMb.toFixed(0)} MB，低内存阈值 ${memory.thresholdMb.toFixed(0)} MB；本进程 PSS ${memory.totalPssMb.toFixed(0)} MB，原生堆已分配 ${memory.nativeHeapAllocatedMb.toFixed(0)} MB。`
              : '暂时无法读取当前内存信息。'}
          </Text>
          <Text style={[styles.cardDesc, { color: colors.muted }]} accessible accessibilityRole="text">
            {previousExit ? describePreviousExit(previousExit) : '没有读取到上一轮异常退出记录。'}
          </Text>
          <TouchableOpacity
            style={[styles.secondaryBtn, { borderColor: colors.primary }]}
            onPress={refreshDiagnostics}
            accessible
            accessibilityRole="button"
            accessibilityLabel="刷新内存和退出原因诊断"
          >
            <Text style={{ color: colors.primary }}>刷新诊断</Text>
          </TouchableOpacity>
        </View>

        {activeModel && (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>当前已加载模型</Text>
            <Text style={[styles.cardDesc, { color: colors.muted }]}>{activeModel.name}</Text>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.warning }]}
              onPress={handleUnloadModel}
              disabled={reloading}
              accessible
              accessibilityRole="button"
              accessibilityLabel="卸载当前模型"
            >
              <Text style={{ color: colors.warning }}>{reloading ? '正在重新加载...' : '卸载模型'}</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={[styles.presetBtn, { borderColor: colors.primary }]}
          onPress={applyMoEPreset}
          disabled={reloading}
          accessible
          accessibilityRole="button"
          accessibilityLabel="应用 30B MoE 稳定优先预设"
          accessibilityHint="保存后可立即重新加载模型，使参数真正生效"
        >
          <Text style={[styles.presetBtnText, { color: colors.primary }]}>30B MoE 稳定优先预设</Text>
        </TouchableOpacity>

        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>上下文与临时缓冲</Text>
          <ParamRow label="最大上下文长度" description="越大越消耗 KV 缓存；长输出也必须容纳在上下文内" value={params.n_ctx} min={512} max={131072} step={512} onChange={(value) => update('n_ctx', value)} colors={colors} />
          <ParamRow label="批处理大小 n_batch" description="降低可减少提示词处理峰值，代价是速度变慢" value={params.n_batch} min={1} max={2048} step={16} onChange={(value) => update('n_batch', value)} colors={colors} />
          <ParamRow label="微批处理大小 n_ubatch" description="直接影响临时计算缓冲；30B 建议从 16 或 32 开始" value={params.n_ubatch} min={1} max={512} step={16} onChange={(value) => update('n_ubatch', value)} colors={colors} />
          <ParamRow label="最大输出 token" description="输出越长，KV 缓存逐步增长" value={params.max_tokens} min={64} max={32768} step={256} onChange={(value) => update('max_tokens', value)} colors={colors} />
        </View>

        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>模型与 KV 内存</Text>
          <ToggleRow label="内存映射 mmap" description="从文件按需映射权重；大模型通常必须开启" value={params.use_mmap} onChange={(value) => update('use_mmap', value)} colors={colors} />
          <ToggleRow label="内存锁定 mlock" description="会阻止模型页被回收；30B 通常必须关闭" value={params.use_mlock} onChange={(value) => update('use_mlock', value)} colors={colors} />
          <ToggleRow label="禁用额外权重重排缓冲" description="对应 no_extra_bufts，降低内存，提示词处理可能变慢" value={params.no_extra_bufts} onChange={(value) => update('no_extra_bufts', value)} colors={colors} />
          <KVChoice label="K 缓存精度" value={params.cache_type_k} onChange={(value) => update('cache_type_k', value)} colors={colors} />
          <KVChoice label="V 缓存精度" value={params.cache_type_v} onChange={(value) => update('cache_type_v', value)} colors={colors} />
        </View>

        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>低内存保护</Text>
          <ToggleRow label="生成时监测系统内存" description="接近系统低内存阈值时主动停止并保留已输出内容；不能保证阻止所有原生崩溃" value={params.memory_guard_enabled} onChange={(value) => update('memory_guard_enabled', value)} colors={colors} />
          <ParamRow label="安全保留内存 MB" description="系统可用内存低于此值时停止生成" value={params.memory_guard_reserve_mb} min={256} max={8192} step={256} onChange={(value) => update('memory_guard_reserve_mb', value)} colors={colors} />
        </View>

        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>计算与采样</Text>
          <ParamRow label="CPU 线程数" description="过多线程可能增加瞬时功耗和温度，不等于更稳定" value={params.n_threads} min={1} max={16} step={1} onChange={(value) => update('n_threads', value)} colors={colors} />
          <ParamRow label="GPU 加速层数" description="Android CPU 稳定模式设为 0" value={params.n_gpu_layers} min={0} max={200} step={1} onChange={(value) => update('n_gpu_layers', value)} colors={colors} />
          <ParamRow label="温度" description="控制随机性" value={params.temperature} min={0} max={2} step={0.05} decimals={2} onChange={(value) => update('temperature', value)} colors={colors} />
          <ParamRow label="Top-P" description="累积概率阈值" value={params.top_p} min={0.05} max={1} step={0.05} decimals={2} onChange={(value) => update('top_p', value)} colors={colors} />
          <ParamRow label="Top-K" description="每步候选 token 数" value={params.top_k} min={1} max={200} step={1} onChange={(value) => update('top_k', value)} colors={colors} />
          <ParamRow label="重复惩罚" description="过高可能破坏文本连贯性" value={params.repeat_penalty} min={0.5} max={2} step={0.05} decimals={2} onChange={(value) => update('repeat_penalty', value)} colors={colors} />
        </View>

        <TouchableOpacity
          style={[styles.resetBtn, { borderColor: colors.error }]}
          onPress={handleReset}
          accessible
          accessibilityRole="button"
          accessibilityLabel="恢复默认推理参数"
        >
          <Text style={{ color: colors.error }}>恢复默认参数</Text>
        </TouchableOpacity>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 40, gap: 14 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, lineHeight: 20 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardDesc: { fontSize: 13, lineHeight: 19 },
  section: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  sectionTitle: { fontSize: 16, fontWeight: '700', padding: 14 },
  paramRow: {
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  paramInfo: { gap: 3 },
  paramLabel: { fontSize: 14, fontWeight: '600' },
  paramDesc: { fontSize: 12, lineHeight: 17 },
  paramControl: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { width: 42, height: 38, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: 22 },
  valueBox: { minWidth: 88, height: 38, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  valueText: { fontSize: 15, fontWeight: '700' },
  choiceRow: { padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 10 },
  choiceButtons: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  choiceBtn: { paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderRadius: 8 },
  presetBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  presetBtnText: { fontSize: 15, fontWeight: '700' },
  secondaryBtn: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  resetBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
});
