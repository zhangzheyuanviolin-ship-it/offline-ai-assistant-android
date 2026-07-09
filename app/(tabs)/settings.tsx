import React, { useCallback } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore, selectActiveModel } from '@/lib/store';
import { DEFAULT_INFERENCE_PARAMS, InferenceParams } from '@/lib/types';
import { releaseModel } from '@/lib/services/model-service';

// ─── Slider Row ───────────────────────────────────────────────────────────────

interface ParamRowProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  onChange: (v: number) => void;
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
  const fmt = (v: number) => (decimals > 0 ? v.toFixed(decimals) : String(v));

  const decrement = () => {
    const next = Math.max(min, parseFloat((value - step).toFixed(decimals + 2)));
    onChange(next);
  };
  const increment = () => {
    const next = Math.min(max, parseFloat((value + step).toFixed(decimals + 2)));
    onChange(next);
  };

  const handleManualInput = () => {
    Alert.prompt(
      `设置 ${label}`,
      `范围：${fmt(min)} ~ ${fmt(max)}，当前：${fmt(value)}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确定',
          onPress: (text: string | undefined) => {
            const num = parseFloat(text ?? '');
            if (isNaN(num)) return;
            const clamped = Math.min(max, Math.max(min, num));
            onChange(parseFloat(clamped.toFixed(decimals + 2)));
          },
        },
      ],
      'plain-text',
      fmt(value),
      'numeric'
    );
  };

  return (
    <View
      style={[styles.paramRow, { borderBottomColor: colors.border }]}
      accessible
      accessibilityLabel={`${label}，当前值 ${fmt(value)}，范围 ${fmt(min)} 到 ${fmt(max)}`}
    >
      <View style={styles.paramInfo}>
        <Text style={[styles.paramLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.paramDesc, { color: colors.muted }]}>{description}</Text>
      </View>
      <View style={styles.paramControl}>
        <TouchableOpacity
          style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
          onPress={decrement}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`减小 ${label}`}
          accessibilityHint={`当前 ${fmt(value)}，双击减小 ${fmt(step)}`}
        >
          <Text style={[styles.stepBtnText, { color: colors.foreground }]}>−</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.valueBox, { borderColor: colors.primary, backgroundColor: colors.background }]}
          onPress={handleManualInput}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${label} 当前值 ${fmt(value)}，双击手动输入`}
        >
          <Text style={[styles.valueText, { color: colors.primary }]}>{fmt(value)}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.stepBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
          onPress={increment}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`增大 ${label}`}
          accessibilityHint={`当前 ${fmt(value)}，双击增大 ${fmt(step)}`}
        >
          <Text style={[styles.stepBtnText, { color: colors.foreground }]}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Settings Screen ──────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const colors = useColors();
  const { inferenceParams, setInferenceParams, setActiveModel, setModelLoaded, activeModelId } =
    useAppStore();
  const activeModel = useAppStore(selectActiveModel);

  const update = useCallback(
    (key: keyof InferenceParams, value: number) => {
      setInferenceParams({ [key]: value });
    },
    [setInferenceParams]
  );

  const handleReset = () => {
    Alert.alert('重置参数', '确定要将所有推理参数恢复为默认值吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '重置',
        onPress: () => {
          setInferenceParams(DEFAULT_INFERENCE_PARAMS);
          Alert.alert('已重置', '推理参数已恢复为默认值');
        },
      },
    ]);
  };

  const handleUnloadModel = async () => {
    if (!activeModel) return;
    Alert.alert('卸载模型', `确定要从内存中卸载 "${activeModel.name}" 吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '卸载',
        style: 'destructive',
        onPress: async () => {
          await releaseModel();
          if (activeModelId) setModelLoaded(activeModelId, false);
          setActiveModel(null);
        },
      },
    ]);
  };

  const params = inferenceParams;

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.container} accessible={false}>
        <Text style={[styles.title, { color: colors.foreground }]} accessibilityRole="header">
          推理参数设置
        </Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          参数在下次加载模型时生效。点击数值可手动输入。
        </Text>

        {/* 当前模型 */}
        {activeModel && (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>当前已加载模型</Text>
            <Text style={[styles.cardDesc, { color: colors.muted }]}>{activeModel.name}</Text>
            <TouchableOpacity
              style={[styles.unloadBtn, { borderColor: colors.warning }]}
              onPress={handleUnloadModel}
              accessible
              accessibilityRole="button"
              accessibilityLabel="卸载当前模型"
              accessibilityHint="双击从内存中卸载当前模型，释放内存"
            >
              <Text style={[styles.unloadBtnText, { color: colors.warning }]}>卸载模型</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 上下文与内存 */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>上下文与内存</Text>

          <ParamRow
            label="最大上下文长度 (n_ctx)"
            description="模型可处理的最大 token 数，越大越消耗内存"
            value={params.n_ctx}
            min={512}
            max={131072}
            step={512}
            onChange={(v) => update('n_ctx', v)}
            colors={colors}
          />

          <ParamRow
            label="批处理大小 (n_batch)"
            description="每次处理的 token 批次大小，影响推理速度"
            value={params.n_batch}
            min={1}
            max={2048}
            step={64}
            onChange={(v) => update('n_batch', v)}
            colors={colors}
          />
        </View>

        {/* 硬件加速 */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>硬件加速</Text>

          <ParamRow
            label="CPU 线程数 (n_threads)"
            description="用于推理的 CPU 线程数，建议设为 CPU 核心数的一半"
            value={params.n_threads}
            min={1}
            max={16}
            step={1}
            onChange={(v) => update('n_threads', v)}
            colors={colors}
          />

          <ParamRow
            label="GPU 加速层数 (n_gpu_layers)"
            description="卸载到 GPU 的模型层数，0 为纯 CPU 推理"
            value={params.n_gpu_layers}
            min={0}
            max={200}
            step={1}
            onChange={(v) => update('n_gpu_layers', v)}
            colors={colors}
          />
        </View>

        {/* 采样参数 */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>采样参数</Text>

          <ParamRow
            label="温度 (temperature)"
            description="控制输出随机性，0 为确定性，2 为高随机性"
            value={params.temperature}
            min={0}
            max={2}
            step={0.05}
            decimals={2}
            onChange={(v) => update('temperature', v)}
            colors={colors}
          />

          <ParamRow
            label="Top-P 采样"
            description="累积概率阈值，越小输出越保守"
            value={params.top_p}
            min={0}
            max={1}
            step={0.05}
            decimals={2}
            onChange={(v) => update('top_p', v)}
            colors={colors}
          />

          <ParamRow
            label="Top-K 采样"
            description="每步候选 token 数量，越小输出越集中"
            value={params.top_k}
            min={1}
            max={200}
            step={1}
            onChange={(v) => update('top_k', v)}
            colors={colors}
          />

          <ParamRow
            label="重复惩罚 (repeat_penalty)"
            description="惩罚重复内容，1.0 为无惩罚，越大越避免重复"
            value={params.repeat_penalty}
            min={1}
            max={2}
            step={0.05}
            decimals={2}
            onChange={(v) => update('repeat_penalty', v)}
            colors={colors}
          />
        </View>

        {/* 输出限制 */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>输出限制</Text>

          <ParamRow
            label="单轮最大输出 (max_tokens)"
            description="每次对话 AI 最多输出的 token 数"
            value={params.max_tokens}
            min={64}
            max={8192}
            step={64}
            onChange={(v) => update('max_tokens', v)}
            colors={colors}
          />
        </View>

        {/* 重置按钮 */}
        <TouchableOpacity
          style={[styles.resetBtn, { borderColor: colors.error }]}
          onPress={handleReset}
          accessible
          accessibilityRole="button"
          accessibilityLabel="重置所有推理参数为默认值"
          accessibilityHint="双击将所有参数恢复为出厂默认值"
        >
          <Text style={[styles.resetBtnText, { color: colors.error }]}>重置为默认值</Text>
        </TouchableOpacity>

        {/* 参数说明 */}
        <View style={[styles.infoBox, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
          <Text style={[styles.infoTitle, { color: colors.foreground }]}>使用提示</Text>
          <Text style={[styles.infoText, { color: colors.muted }]}>
            • 修改参数后需重新加载模型才能生效{'\n'}
            • 增大 n_ctx 会显著增加内存占用{'\n'}
            • 低端设备建议 n_gpu_layers=0，n_threads=4{'\n'}
            • 温度 0.7、Top-P 0.9 适合大多数场景{'\n'}
            • 重复惩罚 1.1 可有效减少重复输出
          </Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 40 },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, lineHeight: 20 },
  card: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 10 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardDesc: { fontSize: 13, lineHeight: 18 },
  unloadBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1, alignSelf: 'flex-start', marginTop: 4 },
  unloadBtnText: { fontSize: 14, fontWeight: '600' },
  section: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8 },
  paramRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  paramInfo: { gap: 2 },
  paramLabel: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  paramDesc: { fontSize: 12, lineHeight: 18 },
  paramControl: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  stepBtn: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: 20, fontWeight: '600', lineHeight: 24 },
  valueBox: { flex: 1, height: 36, borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', minWidth: 70 },
  valueText: { fontSize: 15, fontWeight: '700' },
  resetBtn: { paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, alignItems: 'center' },
  resetBtnText: { fontSize: 16, fontWeight: '700' },
  infoBox: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 8 },
  infoTitle: { fontSize: 15, fontWeight: '700' },
  infoText: { fontSize: 13, lineHeight: 22 },
});
