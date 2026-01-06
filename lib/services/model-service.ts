import * as FileSystem from 'expo-file-system/legacy';
import { AIModel } from '../types';

const MODELS_DIR = `${FileSystem.documentDirectory}ai-models`;
const MODELS_INDEX_FILE = `${MODELS_DIR}/models.json`;

/**
 * 初始化模型目录
 */
export async function initializeModelsDirectory(): Promise<void> {
  try {
    const dirInfo = await FileSystem.getInfoAsync(MODELS_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
    }
  } catch (error) {
    console.error('Failed to initialize models directory:', error);
    throw error;
  }
}

/**
 * 从本地文件系统导入 GGUF 模型
 */
export async function importModel(sourceFilePath: string): Promise<AIModel> {
  try {
    // 获取文件信息
    const fileInfo = await FileSystem.getInfoAsync(sourceFilePath);
    if (!fileInfo.exists) {
      throw new Error('Model file does not exist');
    }

    // 生成模型 ID
    const modelId = `model_${Date.now()}`;
    const fileName = sourceFilePath.split('/').pop() || 'model.gguf';
    const destPath = `${MODELS_DIR}/${modelId}_${fileName}`;

    // 复制文件到模型目录
    await FileSystem.copyAsync({
      from: sourceFilePath,
      to: destPath,
    });

    // 创建模型对象
    const model: AIModel = {
      id: modelId,
      name: fileName,
      filePath: destPath,
      fileSize: fileInfo.size || 0,
      format: 'gguf',
      loadedAt: Date.now(),
      isLoaded: false,
    };

    // 保存模型索引
    await saveModelIndex(model);

    return model;
  } catch (error) {
    console.error('Failed to import model:', error);
    throw error;
  }
}

/**
 * 获取所有已导入的模型
 */
export async function getAllModels(): Promise<AIModel[]> {
  try {
    const indexInfo = await FileSystem.getInfoAsync(MODELS_INDEX_FILE);
    if (!indexInfo.exists) {
      return [];
    }

    const content = await FileSystem.readAsStringAsync(MODELS_INDEX_FILE);
    const models = JSON.parse(content) as AIModel[];
    return models;
  } catch (error) {
    console.error('Failed to get all models:', error);
    return [];
  }
}

/**
 * 删除模型
 */
export async function deleteModel(modelId: string): Promise<void> {
  try {
    // 获取所有模型
    const models = await getAllModels();
    const model = models.find((m) => m.id === modelId);

    if (!model) {
      throw new Error('Model not found');
    }

    // 删除模型文件
    await FileSystem.deleteAsync(model.filePath, { idempotent: true });

    // 更新模型索引
    const updatedModels = models.filter((m) => m.id !== modelId);
    await FileSystem.writeAsStringAsync(MODELS_INDEX_FILE, JSON.stringify(updatedModels, null, 2));
  } catch (error) {
    console.error('Failed to delete model:', error);
    throw error;
  }
}

/**
 * 保存模型索引
 */
async function saveModelIndex(newModel: AIModel): Promise<void> {
  try {
    const models = await getAllModels();
    const existingIndex = models.findIndex((m) => m.id === newModel.id);

    if (existingIndex >= 0) {
      models[existingIndex] = newModel;
    } else {
      models.push(newModel);
    }

    await FileSystem.writeAsStringAsync(MODELS_INDEX_FILE, JSON.stringify(models, null, 2));
  } catch (error) {
    console.error('Failed to save model index:', error);
    throw error;
  }
}

/**
 * 获取模型文件路径
 */
export async function getModelFilePath(modelId: string): Promise<string | null> {
  try {
    const models = await getAllModels();
    const model = models.find((m) => m.id === modelId);
    return model?.filePath || null;
  } catch (error) {
    console.error('Failed to get model file path:', error);
    return null;
  }
}

/**
 * 更新模型加载状态
 */
export async function updateModelLoadStatus(modelId: string, isLoaded: boolean): Promise<void> {
  try {
    const models = await getAllModels();
    const model = models.find((m) => m.id === modelId);

    if (model) {
      model.isLoaded = isLoaded;
      await saveModelIndex(model);
    }
  } catch (error) {
    console.error('Failed to update model load status:', error);
    throw error;
  }
}
