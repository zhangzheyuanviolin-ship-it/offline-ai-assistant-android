import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore, selectActiveModel } from '@/lib/store';
import {
  deleteModelFile,
  loadModel,
  ModelImportMode,
  pickAndImportModel,
  releaseModel,
} from '@/lib/services/model-service';
import { AIModel } from '@/lib/types';

export default function ModelsScreen() {
  const colors = useColors();
  const [isImporting, setIsImporting] = useState(false);
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(0);

  const {
    models,
    activeModelId,
    inferenceParams,
    addModel,
    removeModel,
    setActiveModel,
    setModelLoaded,
    loadModelsFromStorage,
    syncModelLoadedState,
  } = useAppStore();
  const activeModel = useAppStore(selectActiveModel);

  useEffect(() => {
    void loadModelsFromStorage();
  }, [loadModelsFromStorage]);

  const performImport = useCallback(async (mode: ModelImportMode) => {
    setIsImporting(true);
    try {
      const model = await pickAndImportModel(mode);
      if (!model) return;
      addModel(model);
      Alert.alert(
        '导入成功',
        mode === 'external'
          ? `已经验证“${model.name}”对应一个可直接读取的本机文件路径。模型不会复制到应用目录，加载时将使用 mmap。\n大小：${model.fileSizeLabel}`
          : `模型“${model.name}”已完整复制到应用目录。\n大小：${model.fileSizeLabel}`
      );
    } catch (error) {
      Alert.alert(
        '导入失败',
        error instanceof Error
          ? error.message
          : '无法导入模型。直接使用原文件只支持本机内部存储或 SD 卡中的真实文件。'
      );
    } finally {
      setIsImporting(false);
    }
  }, [addModel]);

  const handleImport = useCallback(() => {
    Alert.alert(
      '选择模型文件使用方式',
      '“直接使用原文件”只接受本机内部存储或 SD 卡中能够解析为真实路径的 GGUF；网盘、代理文件和只提供 content 流的来源必须复制到应用目录。',
      [
        { text: '直接使用本机原文件', onPress: () => performImport('external') },
        { text: '复制到应用目录', onPress: () => performImport('copy') },
        { text: '取消', style: 'cancel' },
      ]
    );
  }, [performImport]);

  const handleLoad = useCallback(async (model: AIModel) => {
    if (loadingModelId) return;
    setLoadingModelId(model.id);
    setLoadingProgress(0);
    try {
      await loadModel(model, inferenceParams, (progress) => {
        setLoadingProgress(Math.max(0, Math.min(100, Math.round(progress))));
      });
      setModelLoaded(model.id, true);
      setActiveModel(model.id);
      syncModelLoadedState();
      Alert.alert(
        '加载成功',
        `模型“${model.name}”已加载。当前参数：上下文 ${inferenceParams.n_ctx}，batch ${inferenceParams.n_batch}，ubatch ${inferenceParams.n_ubatch}，KV ${inferenceParams.cache_type_k}/${inferenceParams.cache_type_v}。`
      );
    } catch (error) {
      syncModelLoadedState();
      Alert.alert('加载失败', error instanceof Error ? error.message : '加载模型时发生未知错误');
    } finally {
      setLoadingModelId(null);
      setLoadingProgress(0);
    }
  }, [
    loadingModelId,
    inferenceParams,
    setModelLoaded,
    setActiveModel,
    syncModelLoadedState,
  ]);

  const handleUnload = useCallback(async () => {
    try {
      await releaseModel();
      if (activeModelId) setModelLoaded(activeModelId, false);
      setActiveModel(null);
      syncModelLoadedState();
    } catch (error) {
      Alert.alert('卸载失败', error instanceof Error ? error.message : '未知错误');
    }
  }, [activeModelId, setModelLoaded, setActiveModel, syncModelLoadedState]);

  const handleDelete = useCallback((model: AIModel) => {
    Alert.alert(
      model.storageMode === 'external' ? '移除模型索引' : '删除模型副本',
      model.storageMode === 'external'
        ? `确定从列表移除“${model.name}”吗？手机上的原始 GGUF 文件不会被删除。`
        : `确定删除“${model.name}”吗？应用目录中的模型副本将被永久删除。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确定',
          style: 'destructive',
          onPress: async () => {
            try {
              if (model.id === activeModelId) {
                await releaseModel();
                setActiveModel(null);
              }
              await deleteModelFile(model);
              removeModel(model.id);
              syncModelLoadedState();
            } catch (error) {
              Alert.alert('操作失败', error instanceof Error ? error.message : '未知错误');
            }
          },
        },
      ]
    );
  }, [activeModelId, removeModel, setActiveModel, syncModelLoadedState]);

  const renderModel = useCallback(({ item }: { item: AIModel }) => {
    const isActive = item.id === activeModelId && item.isLoaded;
    const isLoading = item.id === loadingModelId;
    const storageLabel = item.storageMode === 'external' ? '本机原文件' : '应用内副本';

    return (
      <View
        style={[
          styles.modelCard,
          {
            backgroundColor: colors.surface,
            borderColor: isActive ? colors.primary : colors.border,
            borderWidth: isActive ? 2 : 1,
          },
        ]}
        accessible={false}
      >
        <View style={styles.modelInfo} accessible={false}>
          <Text
            style={[styles.modelName, { color: colors.foreground }]}
            accessibilityRole="header"
            accessible
          >
            {item.name}
          </Text>
          <Text
            style={[styles.modelMeta, { color: colors.muted }]}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`大小 ${item.fileSizeLabel}，GGUF，${storageLabel}，${isActive ? '已加载' : '未加载'}`}
          >
            {item.fileSizeLabel} · GGUF · {storageLabel} · {isActive ? '已加载' : '未加载'}
          </Text>
          {isLoading && (
            <Text
              style={[styles.progressText, { color: colors.primary }]}
              accessible
              accessibilityLiveRegion="polite"
              accessibilityLabel={`模型加载进度 ${loadingProgress}%`}
            >
              加载进度：{loadingProgress}%
            </Text>
          )}
        </View>

        <View style={styles.modelActions} accessible={false}>
          {isActive ? (
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: colors.warning }]}
              onPress={handleUnload}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`卸载模型 ${item.name}`}
            >
              <Text style={[styles.actionBtnText, { color: colors.warning }]}>卸载</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.actionBtn, { borderColor: colors.primary }]}
              onPress={() => handleLoad(item)}
              disabled={isLoading || !!loadingModelId}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`加载模型 ${item.name}`}
              accessibilityHint={isLoading ? `当前进度 ${loadingProgress}%` : '双击加载模型'}
            >
              {isLoading
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Text style={[styles.actionBtnText, { color: colors.primary }]}>加载</Text>}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.actionBtn, { borderColor: colors.error }]}
            onPress={() => handleDelete(item)}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${item.storageMode === 'external' ? '移除索引' : '删除副本'} ${item.name}`}
          >
            <Text style={[styles.actionBtnText, { color: colors.error }]}> 
              {item.storageMode === 'external' ? '移除' : '删除'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }, [
    activeModelId,
    loadingModelId,
    loadingProgress,
    colors,
    handleLoad,
    handleUnload,
    handleDelete,
  ]);

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]} accessible={false}>
        <View accessible={false}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]} accessibilityRole="header">模型管理</Text>
          <Text style={[styles.headerSub, { color: colors.muted }]} accessible accessibilityRole="text">
            {models.length > 0
              ? `${models.length} 个模型${activeModel ? `，当前已加载 ${activeModel.name}` : '，当前未加载模型'}`
              : '尚未导入任何模型'}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.importBtn, { backgroundColor: colors.primary }]}
          onPress={handleImport}
          disabled={isImporting}
          accessible
          accessibilityRole="button"
          accessibilityLabel="导入 GGUF 模型"
        >
          {isImporting
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.importBtnText}>+ 导入</Text>}
        </TouchableOpacity>
      </View>

      {models.length === 0 ? (
        <View style={styles.emptyState} accessible accessibilityLabel="暂无模型，请点击导入按钮添加 GGUF 模型">
          <Text style={[styles.emptyIcon, { color: colors.muted }]}>📦</Text>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>暂无模型</Text>
          <Text style={[styles.emptyDesc, { color: colors.muted }]}>从手机存储选择 GGUF 模型文件。</Text>
        </View>
      ) : (
        <FlatList
          data={models}
          keyExtractor={(item) => item.id}
          renderItem={renderModel}
          contentContainerStyle={styles.list}
          accessible={false}
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  headerTitle: { fontSize: 22, fontWeight: '700' },
  headerSub: { fontSize: 13, marginTop: 2 },
  importBtn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, minWidth: 72, alignItems: 'center' },
  importBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  list: { padding: 16, gap: 12 },
  modelCard: { borderRadius: 12, padding: 16, gap: 12 },
  modelInfo: { gap: 5 },
  modelName: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  modelMeta: { fontSize: 13, lineHeight: 18 },
  progressText: { fontSize: 13, fontWeight: '600' },
  modelActions: { flexDirection: 'row', gap: 8 },
  actionBtn: { flex: 1, paddingVertical: 9, borderRadius: 8, borderWidth: 1, alignItems: 'center', minHeight: 38 },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyDesc: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
