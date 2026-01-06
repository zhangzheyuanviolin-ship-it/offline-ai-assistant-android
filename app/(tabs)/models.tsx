import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useAppStore } from '@/lib/store';
import { useColors } from '@/hooks/use-colors';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import {
  importModel,
  getAllModels,
  deleteModel,
} from '@/lib/services/model-service';

/**
 * 模型管理屏幕
 */
export default function ModelsScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams();
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const {
    models,
    currentModel,
    setCurrentModel,
    updateModels,
    addModel,
    removeModel,
  } = useAppStore();

  // 加载模型列表
  useEffect(() => {
    loadModels();
  }, []);

  // 处理导入参数
  useEffect(() => {
    if (params.importPath) {
      handleImportModel(params.importPath as string);
    }
  }, [params.importPath]);

  const loadModels = async () => {
    try {
      setIsLoading(true);
      const loadedModels = await getAllModels();
      updateModels(loadedModels);
    } catch (error) {
      console.error('Failed to load models:', error);
      Alert.alert('Error', 'Failed to load models');
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportModel = async (filePath?: string) => {
    try {
      setIsImporting(true);

      let sourceFilePath = filePath;
      if (!sourceFilePath) {
        const result = await DocumentPicker.getDocumentAsync({
          type: 'application/*',
        });

        if (result.canceled || !result.assets || result.assets.length === 0) {
          return;
        }

        sourceFilePath = result.assets[0].uri;
      }

      if (!sourceFilePath) {
        Alert.alert('Error', 'No file selected');
        return;
      }

      const model = await importModel(sourceFilePath);
      addModel(model);
      setCurrentModel(model);

      Alert.alert('Success', `Model "${model.name}" imported successfully`);
    } catch (error) {
      console.error('Failed to import model:', error);
      Alert.alert('Error', `Failed to import model: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleSelectModel = (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    if (model) {
      setCurrentModel(model);
      Alert.alert('Success', `Model "${model.name}" selected`);
    }
  };

  const handleDeleteModel = (modelId: string) => {
    const model = models.find((m) => m.id === modelId);
    if (!model) return;

    Alert.alert(
      'Delete Model',
      `Are you sure you want to delete "${model.name}"?`,
      [
        { text: 'Cancel', onPress: () => {} },
        {
          text: 'Delete',
          onPress: async () => {
            try {
              await deleteModel(modelId);
              removeModel(modelId);

              if (currentModel?.id === modelId) {
                setCurrentModel(null);
              }

              Alert.alert('Success', 'Model deleted');
            } catch (error) {
              console.error('Failed to delete model:', error);
              Alert.alert('Error', 'Failed to delete model');
            }
          },
          style: 'destructive',
        },
      ]
    );
  };

  return (
    <ScreenContainer className="flex-1 bg-background">
      {/* 标题 */}
      <View className="px-4 py-4 border-b border-border">
        <Text className="text-2xl font-bold text-foreground mb-2">📦 Model Manager</Text>
        <Text className="text-sm text-muted">
          Import and manage GGUF models for local inference
        </Text>
      </View>

      {/* 导入按钮 */}
      <TouchableOpacity
        onPress={() => handleImportModel()}
        disabled={isImporting}
        className="mx-4 mt-4 bg-primary px-4 py-3 rounded-lg"
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel="Import new model"
        accessibilityHint="Tap to select a GGUF model file from your device"
      >
        <Text className="text-center text-background font-semibold">
          {isImporting ? 'Importing...' : '📥 Import Model'}
        </Text>
      </TouchableOpacity>

      {/* 模型列表 */}
      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.primary} />
          <Text className="mt-2 text-muted">Loading models...</Text>
        </View>
      ) : models.length === 0 ? (
        <View className="flex-1 items-center justify-center px-4">
          <Text className="text-center text-lg font-semibold text-foreground mb-2">
            No Models Found
          </Text>
          <Text className="text-center text-sm text-muted">
            Import a GGUF model to get started with local AI inference
          </Text>
        </View>
      ) : (
        <FlatList
          data={models}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          renderItem={({ item }) => (
            <View
              className={`rounded-lg border-2 p-4 ${
                currentModel?.id === item.id
                  ? 'bg-primary/10 border-primary'
                  : 'bg-surface border-border'
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={`Model: ${item.name}`}
              accessibilityHint={`${currentModel?.id === item.id ? 'Currently selected. ' : ''}Tap to select, long press to delete`}
            >
              {/* 模型名称 */}
              <Text className="text-lg font-bold text-foreground mb-2">{item.name}</Text>

              {/* 模型信息 */}
              <View className="gap-1 mb-3">
                <Text className="text-sm text-muted">
                  Size: {(item.fileSize / 1024 / 1024).toFixed(2)} MB
                </Text>
                <Text className="text-sm text-muted">
                  Format: {item.format.toUpperCase()}
                </Text>
                <Text className="text-sm text-muted">
                  Status: {item.isLoaded ? '✅ Loaded' : '⏳ Not loaded'}
                </Text>
              </View>

              {/* 按钮 */}
              <View className="flex-row gap-2">
                <TouchableOpacity
                  onPress={() => handleSelectModel(item.id)}
                  className={`flex-1 py-2 rounded-lg border ${
                    currentModel?.id === item.id
                      ? 'bg-primary border-primary'
                      : 'bg-background border-border'
                  }`}
                  accessible={true}
                  accessibilityRole="button"
                  accessibilityLabel={`Select model ${item.name}`}
                >
                  <Text
                    className={`text-center font-semibold ${
                      currentModel?.id === item.id
                        ? 'text-background'
                        : 'text-foreground'
                    }`}
                  >
                    {currentModel?.id === item.id ? '✓ Selected' : 'Select'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => handleDeleteModel(item.id)}
                  className="flex-1 py-2 rounded-lg bg-error/10 border border-error"
                  accessible={true}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete model ${item.name}`}
                >
                  <Text className="text-center font-semibold text-error">Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}
    </ScreenContainer>
  );
}
