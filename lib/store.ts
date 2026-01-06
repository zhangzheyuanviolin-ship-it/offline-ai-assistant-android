import { create } from 'zustand';
import { AIModel, InferenceParams, ToolsConfig, ChatMessage, ToolLog, AppState } from './types';

interface AppStore extends AppState {
  // 模型管理
  setCurrentModel: (model: AIModel | null) => void;
  addModel: (model: AIModel) => void;
  removeModel: (modelId: string) => void;
  updateModels: (models: AIModel[]) => void;

  // 推理参数
  setInferenceParams: (params: Partial<InferenceParams>) => void;

  // 工具配置
  setToolsConfig: (config: Partial<ToolsConfig>) => void;
  toggleToolCategory: (category: 'WebSearch' | 'Files' | 'Media') => void;
  setSearchEngine: (engine: 'international' | 'domestic') => void;

  // 聊天消息
  addChatMessage: (message: ChatMessage) => void;
  updateChatMessage: (messageId: string, updates: Partial<ChatMessage>) => void;
  clearChatMessages: () => void;

  // 工具日志
  addToolLog: (log: ToolLog) => void;
  clearToolLogs: () => void;
  getRecentToolLogs: (limit: number) => ToolLog[];

  // 推理状态
  setIsInferencing: (isInferencing: boolean) => void;
  setError: (error: string | null) => void;
}

const initialInferenceParams: InferenceParams = {
  n_ctx: 2048,
  threads: 4,
  n_gpu_layers: 0,
  gpu_enabled: false,
};

const initialToolsConfig: ToolsConfig = {
  WebSearch: {
    enabled: true,
    engine: 'international',
    permissionLevel: 'ASK',
  },
  Files: {
    enabled: true,
    permissionLevel: 'ASK',
  },
  Media: {
    enabled: true,
    permissionLevel: 'ASK',
  },
};

export const useAppStore = create<AppStore>((set, get) => ({
  // 初始状态
  currentModel: null,
  models: [],
  inferenceParams: initialInferenceParams,
  toolsConfig: initialToolsConfig,
  chatMessages: [],
  toolLogs: [],
  isInferencing: false,
  error: null,

  // 模型管理
  setCurrentModel: (model) => set({ currentModel: model }),

  addModel: (model) =>
    set((state) => ({
      models: [...state.models, model],
    })),

  removeModel: (modelId) =>
    set((state) => ({
      models: state.models.filter((m) => m.id !== modelId),
      currentModel: state.currentModel?.id === modelId ? null : state.currentModel,
    })),

  updateModels: (models) => set({ models }),

  // 推理参数
  setInferenceParams: (params) =>
    set((state) => ({
      inferenceParams: { ...state.inferenceParams, ...params },
    })),

  // 工具配置
  setToolsConfig: (config) =>
    set((state) => ({
      toolsConfig: { ...state.toolsConfig, ...config },
    })),

  toggleToolCategory: (category) =>
    set((state) => ({
      toolsConfig: {
        ...state.toolsConfig,
        [category]: {
          ...state.toolsConfig[category],
          enabled: !state.toolsConfig[category].enabled,
        },
      },
    })),

  setSearchEngine: (engine) =>
    set((state) => ({
      toolsConfig: {
        ...state.toolsConfig,
        WebSearch: {
          ...state.toolsConfig.WebSearch,
          engine,
        },
      },
    })),

  // 聊天消息
  addChatMessage: (message) =>
    set((state) => ({
      chatMessages: [...state.chatMessages, message],
    })),

  updateChatMessage: (messageId, updates) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((msg) =>
        msg.id === messageId ? { ...msg, ...updates } : msg
      ),
    })),

  clearChatMessages: () => set({ chatMessages: [] }),

  // 工具日志
  addToolLog: (log) =>
    set((state) => {
      const logs = [...state.toolLogs, log];
      // 只保留最近 50 条
      return { toolLogs: logs.slice(-50) };
    }),

  clearToolLogs: () => set({ toolLogs: [] }),

  getRecentToolLogs: (limit) => {
    const state = get();
    return state.toolLogs.slice(-limit);
  },

  // 推理状态
  setIsInferencing: (isInferencing) => set({ isInferencing }),
  setError: (error) => set({ error }),
}));
