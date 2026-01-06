import { Tool, ToolCategory, ToolsConfig, ToolCall, ToolResult, PermissionLevel } from '../types';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * 文件工具定义
 */
const FILE_TOOLS: Tool[] = [
  {
    name: 'list_dir',
    category: 'Files',
    description: 'List files and directories in a given path',
    parameters: {
      path: { type: 'string', description: 'Directory path' },
    },
    permissionLevel: 'ALLOW',
  },
  {
    name: 'read_file',
    category: 'Files',
    description: 'Read file content',
    parameters: {
      path: { type: 'string', description: 'File path' },
      maxBytes: { type: 'number', description: 'Maximum bytes to read (optional)' },
    },
    permissionLevel: 'ALLOW',
  },
  {
    name: 'write_file',
    category: 'Files',
    description: 'Write or create a file',
    parameters: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content' },
      overwrite: { type: 'boolean', description: 'Overwrite if exists (optional)' },
    },
    permissionLevel: 'CAUTION',
  },
  {
    name: 'mkdir',
    category: 'Files',
    description: 'Create a directory',
    parameters: {
      path: { type: 'string', description: 'Directory path' },
    },
    permissionLevel: 'ALLOW',
  },
  {
    name: 'delete',
    category: 'Files',
    description: 'Delete a file or directory',
    parameters: {
      path: { type: 'string', description: 'File or directory path' },
    },
    permissionLevel: 'CAUTION',
  },
  {
    name: 'move',
    category: 'Files',
    description: 'Move or rename a file/directory',
    parameters: {
      src: { type: 'string', description: 'Source path' },
      dst: { type: 'string', description: 'Destination path' },
      overwrite: { type: 'boolean', description: 'Overwrite if exists (optional)' },
    },
    permissionLevel: 'CAUTION',
  },
  {
    name: 'rename',
    category: 'Files',
    description: 'Rename a file or directory',
    parameters: {
      src: { type: 'string', description: 'Current name' },
      dst: { type: 'string', description: 'New name' },
      overwrite: { type: 'boolean', description: 'Overwrite if exists (optional)' },
    },
    permissionLevel: 'CAUTION',
  },
  {
    name: 'compress',
    category: 'Files',
    description: 'Compress files or directory to ZIP',
    parameters: {
      inputPathOrDir: { type: 'string', description: 'File or directory to compress' },
      outputZipPath: { type: 'string', description: 'Output ZIP file path' },
    },
    permissionLevel: 'CAUTION',
  },
  {
    name: 'decompress',
    category: 'Files',
    description: 'Decompress ZIP file',
    parameters: {
      zipPath: { type: 'string', description: 'ZIP file path' },
      outputDir: { type: 'string', description: 'Output directory path' },
    },
    permissionLevel: 'CAUTION',
  },
];

/**
 * 多媒体工具定义
 */
const MEDIA_TOOLS: Tool[] = [
  {
    name: 'extract_audio',
    category: 'Media',
    description: 'Extract audio from video file',
    parameters: {
      videoPath: { type: 'string', description: 'Video file path' },
      outputAudioPath: { type: 'string', description: 'Output audio file path' },
      format: { type: 'string', description: 'Audio format (e.g., mp3, aac)' },
    },
    permissionLevel: 'ASK',
  },
  {
    name: 'transcode_video',
    category: 'Media',
    description: 'Transcode video to different format',
    parameters: {
      inputPath: { type: 'string', description: 'Input video path' },
      outputPath: { type: 'string', description: 'Output video path' },
      targetPreset: { type: 'string', description: 'Target preset (e.g., h264, h265)' },
    },
    permissionLevel: 'ASK',
  },
  {
    name: 'trim_media',
    category: 'Media',
    description: 'Trim media file to specified duration',
    parameters: {
      inputPath: { type: 'string', description: 'Input media path' },
      startSeconds: { type: 'number', description: 'Start time in seconds' },
      endSeconds: { type: 'number', description: 'End time in seconds' },
      outputPath: { type: 'string', description: 'Output media path' },
    },
    permissionLevel: 'ASK',
  },
  {
    name: 'merge_audio',
    category: 'Media',
    description: 'Merge multiple audio files',
    parameters: {
      paths: { type: 'array', description: 'Array of audio file paths' },
      output: { type: 'string', description: 'Output audio file path' },
    },
    permissionLevel: 'ASK',
  },
  {
    name: 'merge_video',
    category: 'Media',
    description: 'Merge multiple video files',
    parameters: {
      paths: { type: 'array', description: 'Array of video file paths' },
      output: { type: 'string', description: 'Output video file path' },
    },
    permissionLevel: 'ASK',
  },
];

/**
 * 网络搜索工具定义
 */
const WEB_SEARCH_TOOLS: Tool[] = [
  {
    name: 'set_search_engine',
    category: 'WebSearch',
    description: 'Set search engine (international or domestic)',
    parameters: {
      engine: { type: 'string', description: 'Engine: international or domestic' },
    },
    permissionLevel: 'ALLOW',
  },
  {
    name: 'web_search',
    category: 'WebSearch',
    description: 'Search the web for information',
    parameters: {
      query: { type: 'string', description: 'Search query' },
      topK: { type: 'number', description: 'Number of results to return' },
    },
    permissionLevel: 'ALLOW',
  },
];

/**
 * 根据工具配置获取可用工具列表
 */
export function getAvailableTools(toolsConfig: ToolsConfig): Tool[] {
  const availableTools: Tool[] = [];

  if (toolsConfig.Files.enabled) {
    availableTools.push(...FILE_TOOLS);
  }

  if (toolsConfig.Media.enabled) {
    availableTools.push(...MEDIA_TOOLS);
  }

  if (toolsConfig.WebSearch.enabled) {
    availableTools.push(...WEB_SEARCH_TOOLS);
  }

  return availableTools;
}

/**
 * 获取工具权限级别
 */
export function getToolPermissionLevel(
  toolName: string,
  toolsConfig: ToolsConfig
): PermissionLevel {
  const tool = [...FILE_TOOLS, ...MEDIA_TOOLS, ...WEB_SEARCH_TOOLS].find(
    (t) => t.name === toolName
  );

  if (!tool) {
    return 'FORBID';
  }

  // 如果工具类别被禁用，则返回 FORBID
  const category = tool.category;
  if (category === 'Files' && !toolsConfig.Files.enabled) {
    return 'FORBID';
  }
  if (category === 'Media' && !toolsConfig.Media.enabled) {
    return 'FORBID';
  }
  if (category === 'WebSearch' && !toolsConfig.WebSearch.enabled) {
    return 'FORBID';
  }

  // 返回工具的权限级别
  if (category === 'Files') {
    return toolsConfig.Files.permissionLevel;
  }
  if (category === 'Media') {
    return toolsConfig.Media.permissionLevel;
  }
  if (category === 'WebSearch') {
    return toolsConfig.WebSearch.permissionLevel;
  }

  return 'FORBID';
}

/**
 * 检查工具是否需要用户确认
 */
export function toolRequiresConfirmation(
  toolName: string,
  toolsConfig: ToolsConfig
): boolean {
  const permissionLevel = getToolPermissionLevel(toolName, toolsConfig);
  return permissionLevel === 'ASK' || permissionLevel === 'CAUTION';
}

/**
 * 执行文件工具
 */
export async function executeFileTool(
  toolName: string,
  parameters: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'list_dir': {
        const path = parameters.path as string;
        const files = await FileSystem.readDirectoryAsync(path);
        return {
          toolName,
          success: true,
          data: { files, count: files.length },
          timestamp: Date.now(),
        };
      }

      case 'read_file': {
        const path = parameters.path as string;
        const maxBytes = (parameters.maxBytes as number) || undefined;
        const content = await FileSystem.readAsStringAsync(path);
        const truncated = maxBytes && content.length > maxBytes;
        return {
          toolName,
          success: true,
          data: {
            content: truncated ? content.substring(0, maxBytes) : content,
            truncated,
            size: content.length,
          },
          timestamp: Date.now(),
        };
      }

      case 'write_file': {
        const path = parameters.path as string;
        const content = parameters.content as string;
        const overwrite = (parameters.overwrite as boolean) || false;

        // 检查文件是否存在
        const fileInfo = await FileSystem.getInfoAsync(path);
        if (fileInfo.exists && !overwrite) {
          throw new Error('File already exists and overwrite is false');
        }

        await FileSystem.writeAsStringAsync(path, content);
        return {
          toolName,
          success: true,
          data: { path, size: content.length },
          timestamp: Date.now(),
        };
      }

      case 'mkdir': {
        const path = parameters.path as string;
        await FileSystem.makeDirectoryAsync(path, { intermediates: true });
        return {
          toolName,
          success: true,
          data: { path },
          timestamp: Date.now(),
        };
      }

      case 'delete': {
        const path = parameters.path as string;
        await FileSystem.deleteAsync(path, { idempotent: true });
        return {
          toolName,
          success: true,
          data: { path },
          timestamp: Date.now(),
        };
      }

      case 'move': {
        const src = parameters.src as string;
        const dst = parameters.dst as string;
        const overwrite = (parameters.overwrite as boolean) || false;

        // 检查目标是否存在
        const dstInfo = await FileSystem.getInfoAsync(dst);
        if (dstInfo.exists && !overwrite) {
          throw new Error('Destination already exists and overwrite is false');
        }

        await FileSystem.moveAsync({ from: src, to: dst });
        return {
          toolName,
          success: true,
          data: { src, dst },
          timestamp: Date.now(),
        };
      }

      case 'rename': {
        const src = parameters.src as string;
        const dst = parameters.dst as string;
        const overwrite = (parameters.overwrite as boolean) || false;

        // 检查目标是否存在
        const dstInfo = await FileSystem.getInfoAsync(dst);
        if (dstInfo.exists && !overwrite) {
          throw new Error('Destination already exists and overwrite is false');
        }

        await FileSystem.moveAsync({ from: src, to: dst });
        return {
          toolName,
          success: true,
          data: { src, dst },
          timestamp: Date.now(),
        };
      }

      default:
        return {
          toolName,
          success: false,
          error: `Unknown file tool: ${toolName}`,
          timestamp: Date.now(),
        };
    }
  } catch (error) {
    return {
      toolName,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now(),
    };
  }
}

/**
 * 执行多媒体工具（占位符实现）
 */
export async function executeMediaTool(
  toolName: string,
  parameters: Record<string, unknown>
): Promise<ToolResult> {
  try {
    // 这是占位符实现，实际实现需要集成 FFmpeg 或 Android MediaCodec
    switch (toolName) {
      case 'extract_audio':
      case 'transcode_video':
      case 'trim_media':
      case 'merge_audio':
      case 'merge_video':
        return {
          toolName,
          success: false,
          error: 'Media tools not yet implemented in this version',
          timestamp: Date.now(),
        };

      default:
        return {
          toolName,
          success: false,
          error: `Unknown media tool: ${toolName}`,
          timestamp: Date.now(),
        };
    }
  } catch (error) {
    return {
      toolName,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now(),
    };
  }
}

/**
 * 执行网络搜索工具（占位符实现）
 */
export async function executeWebSearchTool(
  toolName: string,
  parameters: Record<string, unknown>
): Promise<ToolResult> {
  try {
    // 这是占位符实现，实际实现需要集成搜索 API
    switch (toolName) {
      case 'set_search_engine':
        return {
          toolName,
          success: true,
          data: { engine: parameters.engine },
          timestamp: Date.now(),
        };

      case 'web_search':
        return {
          toolName,
          success: false,
          error: 'Web search not yet implemented in this version',
          timestamp: Date.now(),
        };

      default:
        return {
          toolName,
          success: false,
          error: `Unknown web search tool: ${toolName}`,
          timestamp: Date.now(),
        };
    }
  } catch (error) {
    return {
      toolName,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now(),
    };
  }
}

/**
 * 执行工具
 */
export async function executeTool(
  toolName: string,
  category: ToolCategory,
  parameters: Record<string, unknown>
): Promise<ToolResult> {
  switch (category) {
    case 'Files':
      return executeFileTool(toolName, parameters);
    case 'Media':
      return executeMediaTool(toolName, parameters);
    case 'WebSearch':
      return executeWebSearchTool(toolName, parameters);
    default:
      return {
        toolName,
        success: false,
        error: `Unknown tool category: ${category}`,
        timestamp: Date.now(),
      };
  }
}
