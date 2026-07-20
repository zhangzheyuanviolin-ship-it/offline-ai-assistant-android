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
import { getActiveContext, getActiveModelId } from './services/model-service';

interface AppStore extends AppState {
  addModel: (model: AIModel) => void;
  removeModel: (modelId: string) => void;
  setActiveModel: (modelId: string | null) => void;
  setModelLoaded: (modelId: string, loaded: boolean) => void;
  loadModelsFromStorage: () => Promise<void>;
  syncModelLoadedState: () => void;
  setInferenceParams: (params: Partial<InferenceParams>) => void;
  setToolsConfig: (config: Partial<ToolsConfig>) => void;
  toggleToolCategory: (category: 'WebSearch' | 'Files' | 'Media') => void;
  setSearchEngine: (engine: SearchEngine) => void;
  setSearchApiKey: (provider: 'tavily' | 'exa', key: string) => void;
  setSearchMaxResults: (n: number) => void;
  addMessage: (message: ChatMessage) => void;
  updateMessage: (messageId: string, updates: Partial<ChatMessage>) => void;
  updateToolCall: (messageId: string, toolCallId: string, updates: Partial<ToolCall>) => void;
  removeMessage: (messageId: string) => void;
  clearMessages: () => void;
  addLog: (log: ToolLog) => void;
  clearLogs: () => void;
  setWorkspaceDir: (dir: string) => void;
  setGenerating: (generating: boolean) => void;
  setContextId: (id: string | null) => void;
  setError: (error: string | null) => void;
}

let storageLoadPromise: Promise<void> | null = null;

function persistMessages(messages: ChatMessage[]) {
  const toSave = messages.filter((message) => !message.isActivity && !message.isStreaming);
  AsyncStorage.setItem('messages', JSON.stringify(toSave)).catch(() => {});
}

function persistModels(models: AIModel[]) {
  const serializable = models.map((model) => ({ ...model, isLoaded: false }));
  AsyncStorage.setItem('models', JSON.stringify(serializable)).catch(() => {});
}

export const useAppStore = create<AppStore>((set, get) => ({
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

  addModel: (model) => {
    set((state) => {
      const updated = [...state.models, model];
      persistModels(updated);
      return { models: updated };
    });
  },

  removeModel: (modelId) => {
    set((state) => {
      const updated = state.models.filter((model) => model.id !== modelId);
      const activeModelId = state.activeModelId === modelId ? null : state.activeModelId;
      persistModels(updated);
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
      models: state.models.map((model) =>
        model.id === modelId ? { ...model, isLoaded: loaded } : { ...model, isLoaded: false }
      ),
    }));
  },

  loadModelsFromStorage: async () => {
    if (storageLoadPromise) return storageLoadPromise;

    storageLoadPromise = (async () => {
      try {
        const [modelsJson, activeId, paramsJson, toolsJson, wsJson, messagesJson] = await Promise.all([
          AsyncStorage.getItem('models'),
          AsyncStorage.getItem('activeModelId'),
          AsyncStorage.getItem('inferenceParams'),
          AsyncStorage.getItem('toolsConfig'),
          AsyncStorage.getItem('workspaceDir'),
          AsyncStorage.getItem('messages'),
        ]);

        const storedModels: AIModel[] = modelsJson ? JSON.parse(modelsJson) : [];
        const nativeModelId = getActiveContext() ? getActiveModelId() : null;
        const inferenceParams = paramsJson
          ? { ...DEFAULT_INFERENCE_PARAMS, ...JSON.parse(paramsJson) }
          : DEFAULT_INFERENCE_PARAMS;
        const storedTools = toolsJson ? JSON.parse(toolsJson) : {};
        const toolsConfig: ToolsConfig = {
          ...DEFAULT_TOOLS_CONFIG,
          ...storedTools,
          WebSearch: { ...DEFAULT_TOOLS_CONFIG.WebSearch, ...(storedTools.WebSearch ?? {}) },
          Files: { ...DEFAULT_TOOLS_CONFIG.Files, ...(storedTools.Files ?? {}) },
          Media: { ...DEFAULT_TOOLS_CONFIG.Media, ...(storedTools.Media ?? {}) },
        };
        const messages: ChatMessage[] = messagesJson ? JSON.parse(messagesJson) : [];

        set({
          models: storedModels.map((model) => ({ ...model, isLoaded: model.id === nativeModelId })),
          activeModelId: nativeModelId ?? activeId ?? null,
          inferenceParams,
          toolsConfig,
          workspaceDir: wsJson || '',
          messages,
        });
      } catch (error) {
        console.warn('Failed to load persisted app state', error);
      } finally {
        storageLoadPromise = null;
      }
    })();

    return storageLoadPromise;
  },

  syncModelLoadedState: () => {
    const nativeModelId = getActiveContext() ? getActiveModelId() : null;
    set((state) => ({
      activeModelId: nativeModelId ?? state.activeModelId,
      models: state.models.map((model) => ({ ...model, isLoaded: model.id === nativeModelId })),
    }));
  },

  setInferenceParams: (params) => {
    set((state) => {
      const updated = { ...state.inferenceParams, ...params };
      AsyncStorage.setItem('inferenceParams', JSON.stringify(updated)).catch(() => {});
      return { inferenceParams: updated };
    });
  },

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
        WebSearch: {
          ...state.toolsConfig.WebSearch,
          maxResults: Math.max(1, Math.min(20, n)),
        },
      };
      AsyncStorage.setItem('toolsConfig', JSON.stringify(updated)).catch(() => {});
      return { toolsConfig: updated };
    });
  },

  addMessage: (message) => {
    set((state) => {
      const updated = [...state.messages, message];
      if (!message.isActivity && !message.isStreaming) persistMessages(updated);
      return { messages: updated };
    });
  },

  updateMessage: (messageId, updates) => {
    set((state) => {
      const updated = state.messages.map((message) =>
        message.id === messageId ? { ...message, ...updates } : message
      );
      persistMessages(updated);
      return { messages: updated };
    });
  },

  updateToolCall: (messageId, toolCallId, updates) => {
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== messageId || !message.toolCalls) return message;
        return {
          ...message,
          toolCalls: message.toolCalls.map((toolCall) =>
            toolCall.id === toolCallId ? { ...toolCall, ...updates } : toolCall
          ),
        };
      }),
    }));
  },

  removeMessage: (messageId) => {
    set((state) => {
      const updated = state.messages.filter((message) => message.id !== messageId);
      persistMessages(updated);
      return { messages: updated };
    });
  },

  clearMessages: () => {
    set({ messages: [] });
    AsyncStorage.removeItem('messages').catch(() => {});
  },

  addLog: (log) => set((state) => ({ logs: [...state.logs, log].slice(-50) })),
  clearLogs: () => set({ logs: [] }),

  setWorkspaceDir: (dir) => {
    set({ workspaceDir: dir });
    AsyncStorage.setItem('workspaceDir', dir).catch(() => {});
  },

  setGenerating: (isGenerating) => set({ isGenerating }),
  setContextId: (contextId) => set({ contextId }),
  setError: (error) => set({ error }),
}));

export const selectActiveModel = (state: AppStore) =>
  state.models.find((model) => model.id === state.activeModelId) ?? null;
