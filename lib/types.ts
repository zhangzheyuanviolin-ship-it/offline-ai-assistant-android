/**
 * 核心类型定义
 */

// 模型相关类型
export interface AIModel {
  id: string;
  name: string;
  filePath: string;
  fileSize: number;
  format: 'gguf' | 'other';
  loadedAt: number;
  isLoaded: boolean;
}

// 推理参数类型
export interface InferenceParams {
  n_ctx: number; // 上下文长度
  threads: number; // 线程数
  n_gpu_layers: number; // GPU 层数
  gpu_enabled: boolean; // GPU 加速开关
}

// 工具类型
export type ToolCategory = 'WebSearch' | 'Files' | 'Media';

export type PermissionLevel = 'ALLOW' | 'CAUTION' | 'ASK' | 'FORBID';

export interface Tool {
  name: string;
  category: ToolCategory;
  description: string;
  parameters: Record<string, unknown>;
  permissionLevel: PermissionLevel;
}

// 工具开关配置
export interface ToolsConfig {
  WebSearch: {
    enabled: boolean;
    engine: 'international' | 'domestic'; // 国际引擎 vs 国内引擎
    permissionLevel: PermissionLevel;
  };
  Files: {
    enabled: boolean;
    permissionLevel: PermissionLevel;
  };
  Media: {
    enabled: boolean;
    permissionLevel: PermissionLevel;
  };
}

// 消息类型
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

// 工具调用类型
export interface ToolCall {
  id: string;
  toolName: string;
  toolCategory: ToolCategory;
  parameters: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'rejected' | 'executing' | 'completed' | 'failed';
  result?: ToolResult;
  error?: string;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  data?: unknown;
  error?: string;
  timestamp: number;
}

// 日志类型
export interface ToolLog {
  id: string;
  timestamp: number;
  toolName: string;
  toolCategory: ToolCategory;
  parameters: Record<string, unknown>;
  result: ToolResult;
  userConfirmed: boolean;
  executionTime: number; // 毫秒
}

// 文件工具的参数类型
export interface FileToolParams {
  list_dir?: { path: string };
  read_file?: { path: string; maxBytes?: number };
  write_file?: { path: string; content: string; overwrite?: boolean };
  mkdir?: { path: string };
  delete?: { path: string };
  move?: { src: string; dst: string; overwrite?: boolean };
  rename?: { src: string; dst: string; overwrite?: boolean };
  compress?: { inputPathOrDir: string; outputZipPath: string };
  decompress?: { zipPath: string; outputDir: string };
}

// 多媒体工具的参数类型
export interface MediaToolParams {
  extract_audio?: { videoPath: string; outputAudioPath: string; format: string };
  transcode_video?: { inputPath: string; outputPath: string; targetPreset: string };
  trim_media?: { inputPath: string; startSeconds: number; endSeconds: number; outputPath: string };
  merge_audio?: { paths: string[]; output: string };
  merge_video?: { paths: string[]; output: string };
}

// 网络搜索工具的参数类型
export interface WebSearchToolParams {
  set_search_engine?: { engine: 'international' | 'domestic' };
  web_search?: { query: string; topK: number };
}

// 搜索结果类型
export interface SearchResult {
  title: string;
  source: string;
  summary: string;
  link: string;
}

// 应用状态类型
export interface AppState {
  currentModel: AIModel | null;
  models: AIModel[];
  inferenceParams: InferenceParams;
  toolsConfig: ToolsConfig;
  chatMessages: ChatMessage[];
  toolLogs: ToolLog[];
  isInferencing: boolean;
  error: string | null;
}
