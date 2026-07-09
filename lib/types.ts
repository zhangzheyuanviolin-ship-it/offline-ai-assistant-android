/**
 * 核心类型定义 - Offline AI Assistant
 * llama.rn 0.12.5 / llama.cpp b9888
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

// 完整推理参数（对应 llama.cpp 参数）
export interface InferenceParams {
  // 上下文与内存
  n_ctx: number;          // 最大上下文长度 (512 - 131072)
  n_batch: number;        // 批处理大小 (1 - 2048)
  // 硬件加速
  n_threads: number;      // CPU 线程数 (1 - 16)
  n_gpu_layers: number;   // GPU 加速层数 (0 = 纯 CPU)
  // 采样参数
  temperature: number;    // 温度采样率 (0.0 - 2.0)
  top_p: number;          // Top-P 采样 (0.0 - 1.0)
  top_k: number;          // Top-K 采样 (1 - 200)
  repeat_penalty: number; // 重复惩罚 (1.0 - 2.0)
  // 输出限制
  max_tokens: number;     // 单轮最大输出 token 数 (64 - 8192)
  // 停止词
  stop: string[];         // 停止词列表
}

export const DEFAULT_INFERENCE_PARAMS: InferenceParams = {
  n_ctx: 4096,
  n_batch: 512,
  n_threads: 4,
  n_gpu_layers: 0,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  repeat_penalty: 1.1,
  max_tokens: 2048,
  stop: ['<|end|>', '</s>', '<|im_end|>', '<|eot_id|>'],
};

// ─── Message Types ────────────────────────────────────────────────────────────

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
}

// ─── Tool Types ───────────────────────────────────────────────────────────────

export type ToolCategory = 'WebSearch' | 'Files' | 'Media';
export type PermissionLevel = 'ALLOW' | 'ASK' | 'FORBID';

/**
 * 搜索引擎类型
 * - tavily: Tavily AI Search API（专为 AI 优化，返回结构化摘要）
 * - exa: Exa AI Search API（语义向量搜索）
 * - duckduckgo: DuckDuckGo HTML 抓取（无需 API Key）
 * - baidu: 百度搜索 HTML 抓取（无需 API Key）
 */
export type SearchEngine = 'tavily' | 'exa' | 'duckduckgo' | 'baidu';

export interface ToolsConfig {
  WebSearch: {
    enabled: boolean;
    engine: SearchEngine;
    permissionLevel: PermissionLevel;
    // AI 优化搜索引擎的 API Keys
    tavilyApiKey: string;
    exaApiKey: string;
    // 每次搜索返回的最大结果条数 (1-20)
    maxResults: number;
  };
  Files: {
    enabled: boolean;
    permissionLevel: PermissionLevel;
    dangerousPermission: PermissionLevel; // 删除/覆盖等危险操作
  };
  Media: {
    enabled: boolean;
    permissionLevel: PermissionLevel;
  };
}

export const DEFAULT_TOOLS_CONFIG: ToolsConfig = {
  WebSearch: {
    enabled: true,
    engine: 'tavily',
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
  Media: {
    enabled: true,
    permissionLevel: 'ASK',
  },
};

// ─── Log Types ────────────────────────────────────────────────────────────────

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

// ─── Search Result ────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  source: string;
  summary: string;
  link: string;
}

// ─── App State ────────────────────────────────────────────────────────────────

export interface AppState {
  models: AIModel[];
  activeModelId: string | null;
  inferenceParams: InferenceParams;
  toolsConfig: ToolsConfig;
  messages: ChatMessage[];
  logs: ToolLog[];
  isGenerating: boolean;
  contextId: string | null; // llama.rn context handle
  error: string | null;
}
