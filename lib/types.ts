/**
 * 核心类型定义 - Offline AI Assistant
 * llama.rn 0.12.6 / llama.cpp b9982
 */

// ─── Model Types ─────────────────────────────────────────────────────────────

export interface AIModel {
  id: string;
  name: string;
  filePath: string;
  fileSize: number;
  fileSizeLabel: string;
  format: 'gguf' | 'other';
  addedAt: number;
  isLoaded: boolean;
}

export interface InferenceParams {
  n_ctx: number;
  n_batch: number;
  n_threads: number;
  n_gpu_layers: number;
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
  max_tokens: number;
  stop: string[];
}

export const DEFAULT_INFERENCE_PARAMS: InferenceParams = {
  n_ctx: 2048,
  n_batch: 256,
  n_threads: 4,
  n_gpu_layers: 0,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  repeat_penalty: 1.1,
  max_tokens: 1024,
  stop: ['<|end|>', '</s>', '<|endoftext|>'],
};

// ─── Message Types ───────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ToolCall {
  id: string;
  toolName: string;
  toolCategory: ToolCategory;
  parameters: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'rejected' | 'executing' | 'completed' | 'failed';
  result?: ToolResult;
  error?: string;
  executionTimeMs?: number;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  isActivity?: boolean;
  activityType?: 'thinking' | 'streaming' | 'tool_calling' | 'tool_done' | 'warning' | 'error';
}

// ─── Tool Types ──────────────────────────────────────────────────────────────

export type ToolCategory = 'WebSearch' | 'Files' | 'Media';
export type PermissionLevel = 'ALLOW' | 'ASK' | 'FORBID';
export type SearchEngine = 'tavily' | 'exa' | 'duckduckgo' | 'baidu';

export interface ToolsConfig {
  WebSearch: {
    enabled: boolean;
    engine: SearchEngine;
    permissionLevel: PermissionLevel;
    tavilyApiKey: string;
    exaApiKey: string;
    maxResults: number;
  };
  Files: {
    enabled: boolean;
    permissionLevel: PermissionLevel;
    dangerousPermission: PermissionLevel;
  };
  Media: {
    enabled: boolean;
    permissionLevel: PermissionLevel;
  };
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  WebSearch: {
    enabled: true,
    engine: 'duckduckgo',
    permissionLevel: 'ALLOW',
    tavilyApiKey: '',
    exaApiKey: '',
    maxResults: 5,
  },
  Files: {
    enabled: true,
    permissionLevel: 'ALLOW',
    dangerousPermission: 'ASK',
  },
  // media_proc 尚未接入 FFmpeg，默认不向模型暴露不可执行工具。
  Media: {
    enabled: false,
    permissionLevel: 'FORBID',
  },
};

// ─── Log Types ───────────────────────────────────────────────────────────────

export interface ToolLog {
  id: string;
  timestamp: number;
  toolName: string;
  toolCategory: ToolCategory;
  parameters: Record<string, unknown>;
  result: ToolResult;
  userConfirmed: boolean;
  executionTimeMs: number;
}

export interface SearchResult {
  title: string;
  source: string;
  summary: string;
  link: string;
}

export interface AppState {
  models: AIModel[];
  activeModelId: string | null;
  inferenceParams: InferenceParams;
  toolsConfig: ToolsConfig;
  messages: ChatMessage[];
  logs: ToolLog[];
  isGenerating: boolean;
  contextId: string | null;
  error: string | null;
  workspaceDir: string;
}
