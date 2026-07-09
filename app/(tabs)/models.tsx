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
  pickAndImportModel,
  deleteModelFile,
  loadModel,
  releaseModel,
} from '@/lib/services/model-service';
import { AIModel } from '@/lib/types';

export default function ModelsScreen() {
  const colors = useColors();
  const [isImporting, setIsImporting] = useState(false);
  const [loadingModelId, setLoadingModelId] = useState<string | null>(null);

  const {
    models,
    activeModelId,
    inferenceParams,
    addModel,
    removeModel,
    setActiveModel,
    setModelLoaded,
    loadModelsFromStorage,
  } = useAppStore();

  const activeModel = useAppStore(selectActiveModel);

  useEffect(() => {
    loadModelsFromStorage();
  }, []);

  const handleImport = useCallback(async () => {
    setIsImporting(true);
    try {
      const model = await pickAndImportModel();
      if (!model) return;
      addModel(model);
      Alert.alert('导入成功', `模型 "${model.name}" 已导入\n大小：${model.fileSizeLabel}`);
    } catch (err) {
      Alert.alert('导入失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setIsImporting(false);
    }
  }, [addModel]);

  const handleLoad = useCallback(
    async (model: AIModel) => {
      if (loadingModelId) return;
      setLoadingModelId(model.id);
      try {
        await loadModel(model, inferenceParams, (progress) => {
          // progress 0-100
          console.log(`Loading model: ${progress}%`);
        });
        setModelLoaded(model.id, true);
        setActiveModel(model.id);
        Alert.alert('加载成功', `模型 "${model.name}" 已加载到内存，可以开始对话`);
      } catch (err) {
        Alert.alert('加载失败', err instanceof Error ? err.message : '加载模型时出错');
      } finally {
        setLoadingModelId(null);
      }
    },
    [loadingModelId, inferenceParams, setModelLoaded, setActiveModel]
  );

  const handleUnload = useCallback(async () => {
    try {
      await releaseModel();
      if (activeModelId) setModelLoaded(activeModelId, false);
      setActiveModel(null);
    } catch (err) {
      Alert.alert('卸载失败', err instanceof Error ? err.message : '未知错误');
    }
  }, [activeModelId, setModelLoaded, setActiveModel]);

  const handleDelete = useCallback(
    (model: AIModel) => {
      Alert.alert(
        '删除模型',
        `确定要删除 "${model.name}" 吗？\n此操作不可撤销。`,
        [
          { text: '取消', style: 'cancel' },
          {
            text: '删除',
            style: 'destructive',
            onPress: async () => {
              try {
                if (model.id === activeModelId) {
                  await releaseModel();
                  setActiveModel(null);
                }
                await deleteModelFile(model);
                removeModel(model.id);
              } catch (err) {
                Alert.alert('删除失败', err instanceof Error ? err.message : '未知错误');
              }
            },
          },
        ]
      );
    },
    [activeModelId, removeModel, setActiveModel]
  );

  const renderModel = useCallback(
    ({ item }: { item: AIModel }) => {
      const isActive = item.id === activeModelId;
      const isLoading = item.id === loadingModelId;

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
          accessible
          accessibilityRole="none"
          accessibilityLabel={`模型：${item.name}，大小 ${item.fileSizeLabel}，${isActive ? '当前已加载' : '未加载'}`}
        >
          <View style={styles.modelInfo}>
            <Text
              style={[styles.modelName, { color: colors.foreground }]}
              numberOfLines={2}
              accessibilityRole="text"
            >
              {item.name}
            </Text>
            <Text style={[styles.modelMeta, { color: colors.muted }]}>
              {item.fileSizeLabel} · GGUF · {isActive ? '✅ 已加载' : '⏳ 未加载'}
            </Text>
            <Text style={[styles.modelPath, { color: colors.muted }]} numberOfLines={1}>
              {item.filePath.split('/').pop()}
            </Text>
          </View>

          <View style={styles.modelActions}>
            {isActive ? (
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: colors.warning + '22', borderColor: colors.warning }]}
                onPress={handleUnload}
                accessible
                accessibilityRole="button"
                accessibilityLabel={`卸载模型 ${item.name}`}
                accessibilityHint="双击从内存中卸载此模型"
              >
                <Text style={[styles.actionBtnText, { color: colors.warning }]}>卸载</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: colors.primary + '22', borderColor: colors.primary }]}
                onPress={() => handleLoad(item)}
                disabled={isLoading || !!loadingModelId}
                accessible
                accessibilityRole="button"
                accessibilityLabel={`加载模型 ${item.name}`}
                accessibilityHint="双击将此模型加载到内存"
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={[styles.actionBtnText, { color: colors.primary }]}>加载</Text>
                )}
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.error + '22', borderColor: colors.error }]}
              onPress={() => handleDelete(item)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`删除模型 ${item.name}`}
              accessibilityHint="双击删除此模型文件"
            >
              <Text style={[styles.actionBtnText, { color: colors.error }]}>删除</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [activeModelId, loadingModelId, colors, handleLoad, handleUnload, handleDelete]
  );

  return (
    <ScreenContainer>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View>
          <Text
            style={[styles.headerTitle, { color: colors.foreground }]}
            accessibilityRole="header"
          >
            模型管理
          </Text>
          <Text style={[styles.headerSub, { color: colors.muted }]}>
            {models.length > 0
              ? `${models.length} 个模型${activeModel ? `，当前：${activeModel.name}` : ''}`
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
          accessibilityHint="双击从文件选择器导入 GGUF 格式的模型文件"
        >
          {isImporting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.importBtnText}>+ 导入</Text>
          )}
        </TouchableOpacity>
      </View>

      {models.length === 0 ? (
        <View style={styles.emptyState} accessible accessibilityLabel="暂无模型，请点击导入按钮添加 GGUF 模型">
          <Text style={[styles.emptyIcon, { color: colors.muted }]}>📦</Text>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>暂无模型</Text>
          <Text style={[styles.emptyDesc, { color: colors.muted }]}>
            点击右上角"导入"按钮，从设备选择 GGUF 格式的模型文件。{'\n\n'}
            推荐模型：Qwen2.5-7B-Instruct-Q4_K_M.gguf（约 4GB）
          </Text>
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
  },
  headerTitle: { fontSize: 22, fontWeight: '700' },
  headerSub: { fontSize: 13, marginTop: 2 },
  importBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  importBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  list: { padding: 16, gap: 12 },
  modelCard: { borderRadius: 12, padding: 16, gap: 12 },
  modelInfo: { gap: 4 },
  modelName: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  modelMeta: { fontSize: 13, lineHeight: 18 },
  modelPath: { fontSize: 11, lineHeight: 16 },
  modelActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 36,
  },
  actionBtnText: { fontSize: 14, fontWeight: '600' },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyDesc: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
