import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import {
  AIModel,
  AppState,
  ChatMessage,
  DEFAULT_INFERENCE_PARAMS,
  DEFAULT_TOOLS_CONFIG,
  InferenceParams,
  SearchEngine,
  ToolCall,
  ToolLog,
  ToolsConfig,
} from './types';

interface AppStore extends AppState {
  // 模型管理
  addModel: (model: AIModel) => void;
  removeModel: (modelId: string) => void;
  setActiveModel: (modelId: string | null) => void;
  setModelLoaded: (modelId: string, loaded: boolean) => void;
  loadModelsFromStorage: () => Promise<void>;

  // 推理参数
  setInferenceParams: (params: Partial<InferenceParams>) => void;

  // 工具配置
  setToolsConfig: (config: Partial<ToolsConfig>) => void;
  toggleToolCategory: (category: 'WebSearch' | 'Files' | 'Media') => void;
  setSearchEngine: (engine: SearchEngine) => void;
  setSearchApiKey: (provider: 'tavily' | 'exa', key: string) => void;
  setSearchMaxResults: (n: number) => void;

  // 聊天消息
  addMessage: (message: ChatMessage) => void;
  updateMessage: (messageId: string, updates: Partial<ChatMessage>) => void;
  updateToolCall: (messageId: string, toolCallId: string, updates: Partial<ToolCall>) => void;
  clearMessages: () => void;

  // 工具日志
  addLog: (log: ToolLog) => void;
  clearLogs: () => void;

  // 推理状态
  setGenerating: (generating: boolean) => void;
  setContextId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  // ─── Initial State ────────────────────────────────────────────────────────
  models: [],
  activeModelId: null,
  inferenceParams: DEFAULT_INFERENCE_PARAMS,
  toolsConfig: DEFAULT_TOOLS_CONFIG,
  messages: [],
  logs: [],
  isGenerating: false,
  contextId: null,
  error: null,

  // ─── Model Management ─────────────────────────────────────────────────────
  addModel: (model) => {
    set((state) => {
      const updated = [...state.models, model];
      AsyncStorage.setItem('models', JSON.stringify(updated)).catch(() => {});
      return { models: updated };
    });
  },

  removeModel: (modelId) => {
    set((state) => {
      const updated = state.models.filter((m) => m.id !== modelId);
      AsyncStorage.setItem('models', JSON.stringify(updated)).catch(() => {});
      const activeModelId = state.activeModelId === modelId ? null : state.activeModelId;
      return { models: updated, activeModelId };
    });
  },

  setActiveModel: (modelId) => {
    set({ activeModelId: modelId });
    AsyncStorage.setItem('activeModelId', modelId ?? '').catch(() => {});
  },

  setModelLoaded: (modelId, loaded) => {
    set((state) => ({
      models: state.models.map((m) =>
        m.id === modelId ? { ...m, isLoaded: loaded } : m
      ),
    }));
  },

  loadModelsFromStorage: async () => {
    try {
      const [modelsJson, activeId, paramsJson, toolsJson] = await Promise.all([
        AsyncStorage.getItem('models'),
        AsyncStorage.getItem('activeModelId'),
        AsyncStorage.getItem('inferenceParams'),
        AsyncStorage.getItem('toolsConfig'),
      ]);
      const models: AIModel[] = modelsJson ? JSON.parse(modelsJson) : [];
      const inferenceParams = paramsJson
        ? { ...DEFAULT_INFERENCE_PARAMS, ...JSON.parse(paramsJson) }
        : DEFAULT_INFERENCE_PARAMS;
      const toolsConfig = toolsJson
        ? { ...DEFAULT_TOOLS_CONFIG, ...JSON.parse(toolsJson) }
        : DEFAULT_TOOLS_CONFIG;
      set({
        models: models.map((m) => ({ ...m, isLoaded: false })),
        activeModelId: activeId || null,
        inferenceParams,
        toolsConfig,
      });
    } catch {
      // ignore storage errors
    }
  },

  // ─── Inference Params ─────────────────────────────────────────────────────
  setInferenceParams: (params) => {
    set((state) => {
      const updated = { ...state.inferenceParams, ...params };
      AsyncStorage.setItem('inferenceParams', JSON.stringify(updated)).catch(() => {});
      return { inferenceParams: updated };
    });
  },

  // ─── Tool Config ──────────────────────────────────────────────────────────
  setToolsConfig: (config) => {
    set((state) => {
      const updated = { ...state.toolsConfig, ...config };
      AsyncStorage.setItem('toolsConfig', JSON.stringify(updated)).catch(() => {});
      return { toolsConfig: updated };
    });
  },

  toggleToolCategory: (category) => {
    set((state) => {
      const updated = {
        ...state.toolsConfig,
        [category]: {
          ...state.toolsConfig[category],
          enabled: !state.toolsConfig[category].enabled,
        },
      };
      AsyncStorage.setItem('toolsConfig', JSON.stringify(updated)).catch(() => {});
      return { toolsConfig: updated };
    });
  },

  setSearchEngine: (engine) => {
    set((state) => {
      const updated = {
        ...state.toolsConfig,
        WebSearch: { ...state.toolsConfig.WebSearch, engine },
      };
      AsyncStorage.setItem('toolsConfig', JSON.stringify(updated)).catch(() => {});
      return { toolsConfig: updated };
    });
  },

  setSearchApiKey: (provider, key) => {
    set((state) => {
      const field = provider === 'tavily' ? 'tavilyApiKey' : 'exaApiKey';
      const updated = {
        ...state.toolsConfig,
        WebSearch: { ...state.toolsConfig.WebSearch, [field]: key },
      };
      AsyncStorage.setItem('toolsConfig', JSON.stringify(updated)).catch(() => {});
      return { toolsConfig: updated };
    });
  },

  setSearchMaxResults: (n) => {
    set((state) => {
      const updated = {
        ...state.toolsConfig,
        WebSearch: { ...state.toolsConfig.WebSearch, maxResults: Math.max(1, Math.min(20, n)) },
      };
      AsyncStorage.setItem('toolsConfig', JSON.stringify(updated)).catch(() => {});
      return { toolsConfig: updated };
    });
  },

  // ─── Messages ─────────────────────────────────────────────────────────────
  addMessage: (message) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },

  updateMessage: (messageId, updates) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, ...updates } : m
      ),
    }));
  },

  updateToolCall: (messageId, toolCallId, updates) => {
    set((state) => ({
      messages: state.messages.map((m) => {
        if (m.id !== messageId || !m.toolCalls) return m;
        return {
          ...m,
          toolCalls: m.toolCalls.map((tc) =>
            tc.id === toolCallId ? { ...tc, ...updates } : tc
          ),
        };
      }),
    }));
  },

  clearMessages: () => set({ messages: [] }),

  // ─── Logs ─────────────────────────────────────────────────────────────────
  addLog: (log) => {
    set((state) => {
      const updated = [...state.logs, log].slice(-50); // 最多保留 50 条
      return { logs: updated };
    });
  },

  clearLogs: () => set({ logs: [] }),

  // ─── Inference State ──────────────────────────────────────────────────────
  setGenerating: (isGenerating) => set({ isGenerating }),
  setContextId: (contextId) => set({ contextId }),
  setError: (error) => set({ error }),
}));

// 便捷选择器
export const selectActiveModel = (state: AppStore) =>
  state.models.find((m) => m.id === state.activeModelId) ?? null;
