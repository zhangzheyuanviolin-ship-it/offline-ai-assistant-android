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
import { getActiveContext } from './services/model-service';

interface AppStore extends AppState {
  // 模型管理
  addModel: (model: AIModel) => void;
  removeModel: (modelId: string) => void;
  setActiveModel: (modelId: string | null) => void;
  setModelLoaded: (modelId: string, loaded: boolean) => void;
  loadModelsFromStorage: () => Promise<void>;
  syncModelLoadedState: () => void;

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
  removeMessage: (messageId: string) => void;
  clearMessages: () => void;

  // 工具日志
  addLog: (log: ToolLog) => void;
  clearLogs: () => void;

  // 工作区
  setWorkspaceDir: (dir: string) => void;

  // 推理状态
  setGenerating: (generating: boolean) => void;
  setContextId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

// 持久化消息到 AsyncStorage（节流：只在非流式消息时持久化）
function persistMessages(messages: ChatMessage[]) {
  // 只持久化非 activity 消息，且只持久化非流式中的消息
  const toSave = messages.filter(m => !m.isActivity && !m.isStreaming);
  AsyncStorage.setItem('messages', JSON.stringify(toSave)).catch(() => {});
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
  workspaceDir: '',

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
      AsyncStorage.setItem('activeModelId', activeModelId ?? '').catch(() => {});
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
      const [modelsJson, activeId, paramsJson, toolsJson, wsJson, messagesJson] = await Promise.all([
        AsyncStorage.getItem('models'),
        AsyncStorage.getItem('activeModelId'),
        AsyncStorage.getItem('inferenceParams'),
        AsyncStorage.getItem('toolsConfig'),
        AsyncStorage.getItem('workspaceDir'),
        AsyncStorage.getItem('messages'),
      ]);
      const models: AIModel[] = modelsJson ? JSON.parse(modelsJson) : [];
      const inferenceParams = paramsJson
        ? { ...DEFAULT_INFERENCE_PARAMS, ...JSON.parse(paramsJson) }
        : DEFAULT_INFERENCE_PARAMS;
      const toolsConfig = toolsJson
        ? { ...DEFAULT_TOOLS_CONFIG, ...JSON.parse(toolsJson) }
        : DEFAULT_TOOLS_CONFIG;
      const messages: ChatMessage[] = messagesJson ? JSON.parse(messagesJson) : [];
      set({
        models: models.map((m) => ({ ...m, isLoaded: false })),
        activeModelId: activeId || null,
        inferenceParams,
        toolsConfig,
        workspaceDir: wsJson || '',
        messages,
      });
    } catch {
      // ignore storage errors
    }
  },

  // 检查 native 侧模型上下文是否仍然存活，同步 isLoaded 状态
  syncModelLoadedState: () => {
    const ctx = getActiveContext();
    const state = get();
    if (ctx && state.activeModelId) {
      // native 上下文存在，标记对应模型为已加载
      set({
        models: state.models.map((m) =>
          m.id === state.activeModelId ? { ...m, isLoaded: true } : { ...m, isLoaded: false }
        ),
      });
    } else {
      // native 上下文不存在，所有模型标记为未加载
      set({
        models: state.models.map((m) => ({ ...m, isLoaded: false })),
      });
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
    set((state) => {
      const updated = [...state.messages, message];
      // 只持久化非 activity、非 streaming 的消息
      if (!message.isActivity && !message.isStreaming) {
        persistMessages(updated);
      }
      return { messages: updated };
    });
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

  removeMessage: (messageId) => {
    set((state) => {
      const updated = state.messages.filter((m) => m.id !== messageId);
      persistMessages(updated);
      return { messages: updated };
    });
  },

  clearMessages: () => {
    set({ messages: [] });
    AsyncStorage.removeItem('messages').catch(() => {});
  },

  // ─── Logs ─────────────────────────────────────────────────────────────────
  addLog: (log) => {
    set((state) => {
      const updated = [...state.logs, log].slice(-50);
      return { logs: updated };
    });
  },

  clearLogs: () => set({ logs: [] }),

  // ─── Workspace ────────────────────────────────────────────────────────────
  setWorkspaceDir: (dir) => {
    set({ workspaceDir: dir });
    AsyncStorage.setItem('workspaceDir', dir).catch(() => {});
  },

  // ─── Inference State ──────────────────────────────────────────────────────
  setGenerating: (isGenerating) => set({ isGenerating }),
  setContextId: (contextId) => set({ contextId }),
  setError: (error) => set({ error }),
}));

// 便捷选择器
export const selectActiveModel = (state: AppStore) =>
  state.models.find((m) => m.id === state.activeModelId) ?? null;