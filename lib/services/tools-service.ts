/**
 * 极简工具调用系统 - 专为手机端小模型优化
 *
 * 设计原则：
 * 1. 极简 JSON 格式：{"t":"工具名","p":{参数}} 最短触发
 * 2. 工具数量精简：合并相似功能，减少模型选择难度
 * 3. 系统提示极简：工具描述控制在 200 token 以内
 * 4. 参数名极短：path→p, content→c, query→q 等
 *
 * 搜索引擎：
 * - tavily: Tavily AI Search（专为 AI 优化，返回结构化摘要，需 API Key）
 * - exa: Exa AI Search（语义向量搜索，需 API Key）
 * - duckduckgo: DuckDuckGo HTML 抓取（无需 API Key）
 * - baidu: 百度搜索 HTML 抓取（无需 API Key）
 */

import * as FileSystem from 'expo-file-system/legacy';
import { PermissionLevel, SearchEngine, ToolCategory, ToolResult, ToolsConfig } from '../types';

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  category: ToolCategory;
  desc: string;
  params: Record<string, { t: string; d: string; req?: boolean }>;
  dangerous: boolean;
}

const FILE_TOOLS: ToolDef[] = [
  { name: 'ls',    category: 'Files', desc: '列出目录内容',        params: { p: { t: 'str', d: '目录路径', req: true } }, dangerous: false },
  { name: 'cat',   category: 'Files', desc: '读取文件内容',        params: { p: { t: 'str', d: '文件路径', req: true }, n: { t: 'int', d: '最大字节数' } }, dangerous: false },
  { name: 'write', category: 'Files', desc: '写入文件',            params: { p: { t: 'str', d: '文件路径', req: true }, c: { t: 'str', d: '内容', req: true }, ow: { t: 'bool', d: '覆盖' } }, dangerous: true },
  { name: 'mkdir', category: 'Files', desc: '创建目录',            params: { p: { t: 'str', d: '目录路径', req: true } }, dangerous: false },
  { name: 'rm',    category: 'Files', desc: '删除文件或目录',      params: { p: { t: 'str', d: '路径', req: true } }, dangerous: true },
  { name: 'mv',    category: 'Files', desc: '移动或重命名文件',    params: { src: { t: 'str', d: '源路径', req: true }, dst: { t: 'str', d: '目标路径', req: true } }, dangerous: true },
  { name: 'zip',   category: 'Files', desc: '压缩/解压文件',       params: { p: { t: 'str', d: '输入路径', req: true }, o: { t: 'str', d: '输出路径', req: true }, mode: { t: 'str', d: 'zip或unzip', req: true } }, dangerous: false },
];

const MEDIA_TOOLS: ToolDef[] = [
  { name: 'media_info', category: 'Media', desc: '获取媒体文件信息',                           params: { p: { t: 'str', d: '媒体文件路径', req: true } }, dangerous: false },
  { name: 'media_proc', category: 'Media', desc: '处理媒体(提取音频/转码/裁剪/合并)', params: { op: { t: 'str', d: 'extract_audio|transcode|trim|merge', req: true }, p: { t: 'str', d: '输入路径', req: true }, o: { t: 'str', d: '输出路径', req: true }, args: { t: 'obj', d: '额外参数' } }, dangerous: false },
];

const WEB_TOOLS: ToolDef[] = [
  { name: 'search', category: 'WebSearch', desc: '搜索网络信息', params: { q: { t: 'str', d: '搜索词', req: true }, n: { t: 'int', d: '结果数' } }, dangerous: false },
];

const ALL_TOOLS = [...FILE_TOOLS, ...MEDIA_TOOLS, ...WEB_TOOLS];

// ─── System Prompt Builder ────────────────────────────────────────────────────

export function buildCompactSystemPrompt(toolsConfig: ToolsConfig): string {
  const available = getAvailableTools(toolsConfig);
  if (available.length === 0) return '';

  const lines = available.map((t) => {
    const paramStr = Object.entries(t.params)
      .filter(([, v]) => v.req)
      .map(([k]) => k)
      .join(',');
    return `${t.name}(${paramStr}): ${t.desc}`;
  });

  return `\n\n[工具]\n调用格式: {"t":"工具名","p":{参数}}\n${lines.join('\n')}\n调用后等待结果再继续。`;
}

// ─── Tool Call Parser ─────────────────────────────────────────────────────────

export interface ParsedToolCall {
  toolName: string;
  parameters: Record<string, unknown>;
  raw: string;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const patterns = [
    /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g,
    /(\{[^{}]*"t"\s*:\s*"[^"]+[^{}]*\})/g,
    /(\{[^{}]*"tool"\s*:\s*"[^"]+[^{}]*\})/g,
  ];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1] ?? match[0];
      if (seen.has(raw)) continue;
      seen.add(raw);
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.t === 'string') {
          const tool = ALL_TOOLS.find((t) => t.name === parsed.t);
          if (tool) results.push({ toolName: parsed.t, parameters: (parsed.p && typeof parsed.p === 'object') ? parsed.p : {}, raw });
        } else if (typeof parsed.tool === 'string') {
          const tool = ALL_TOOLS.find((t) => t.name === parsed.tool);
          if (tool) results.push({ toolName: parsed.tool, parameters: parsed.parameters ?? parsed.args ?? parsed.params ?? {}, raw });
        }
      } catch { /* ignore */ }
    }
  }
  return results;
}

// ─── Tool Helpers ─────────────────────────────────────────────────────────────

export function getAvailableTools(toolsConfig: ToolsConfig): ToolDef[] {
  const tools: ToolDef[] = [];
  if (toolsConfig.Files.enabled) tools.push(...FILE_TOOLS);
  if (toolsConfig.Media.enabled) tools.push(...MEDIA_TOOLS);
  if (toolsConfig.WebSearch.enabled) tools.push(...WEB_TOOLS);
  return tools;
}

export function getToolDef(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export function getToolCategory(name: string): ToolCategory | null {
  return ALL_TOOLS.find((t) => t.name === name)?.category ?? null;
}

export function getToolPermissionLevel(toolName: string, toolsConfig: ToolsConfig): PermissionLevel {
  const tool = getToolDef(toolName);
  if (!tool) return 'FORBID';
  const { category } = tool;
  if (category === 'Files' && !toolsConfig.Files.enabled) return 'FORBID';
  if (category === 'Media' && !toolsConfig.Media.enabled) return 'FORBID';
  if (category === 'WebSearch' && !toolsConfig.WebSearch.enabled) return 'FORBID';
  if (category === 'Files') return tool.dangerous ? toolsConfig.Files.dangerousPermission : toolsConfig.Files.permissionLevel;
  if (category === 'Media') return toolsConfig.Media.permissionLevel;
  if (category === 'WebSearch') return toolsConfig.WebSearch.permissionLevel;
  return 'FORBID';
}

export function toolRequiresConfirmation(toolName: string, toolsConfig: ToolsConfig): boolean {
  return getToolPermissionLevel(toolName, toolsConfig) === 'ASK';
}

// ─── File Tool Execution ──────────────────────────────────────────────────────

async function execFileTool(name: string, p: Record<string, unknown>): Promise<ToolResult> {
  const ts = Date.now();
  try {
    switch (name) {
      case 'ls': {
        const path = p.p as string;
        const files = await FileSystem.readDirectoryAsync(path);
        const details = await Promise.all(
          files.map(async (f) => {
            const info = await FileSystem.getInfoAsync(`${path}/${f}`);
            return { name: f, dir: info.isDirectory ?? false, size: (info as { size?: number }).size ?? 0 };
          })
        );
        return { toolName: name, success: true, data: { files: details, count: files.length }, timestamp: ts };
      }
      case 'cat': {
        const content = await FileSystem.readAsStringAsync(p.p as string);
        const maxBytes = (p.n as number) || 65536;
        const truncated = content.length > maxBytes;
        return { toolName: name, success: true, data: { content: truncated ? content.substring(0, maxBytes) + '\n...[截断]' : content, truncated }, timestamp: ts };
      }
      case 'write': {
        const info = await FileSystem.getInfoAsync(p.p as string);
        if (info.exists && !p.ow) throw new Error('文件已存在，设置 ow:true 以覆盖');
        await FileSystem.writeAsStringAsync(p.p as string, p.c as string);
        return { toolName: name, success: true, data: { path: p.p, bytes: (p.c as string).length }, timestamp: ts };
      }
      case 'mkdir':
        await FileSystem.makeDirectoryAsync(p.p as string, { intermediates: true });
        return { toolName: name, success: true, data: { path: p.p }, timestamp: ts };
      case 'rm':
        await FileSystem.deleteAsync(p.p as string, { idempotent: true });
        return { toolName: name, success: true, data: { path: p.p }, timestamp: ts };
      case 'mv':
        await FileSystem.moveAsync({ from: p.src as string, to: p.dst as string });
        return { toolName: name, success: true, data: { src: p.src, dst: p.dst }, timestamp: ts };
      case 'zip':
        return { toolName: name, success: false, error: `${p.mode} 功能需要 react-native-zip-archive（待集成）`, timestamp: ts };
      default:
        return { toolName: name, success: false, error: `未知文件工具: ${name}`, timestamp: ts };
    }
  } catch (e) {
    return { toolName: name, success: false, error: String(e), timestamp: ts };
  }
}

// ─── Media Tool Execution ─────────────────────────────────────────────────────

async function execMediaTool(name: string, p: Record<string, unknown>): Promise<ToolResult> {
  const ts = Date.now();
  if (name === 'media_info') {
    try {
      const info = await FileSystem.getInfoAsync(p.p as string);
      return { toolName: name, success: true, data: { path: p.p, exists: info.exists, size: (info as { size?: number }).size ?? 0, isDir: info.isDirectory }, timestamp: ts };
    } catch (e) {
      return { toolName: name, success: false, error: String(e), timestamp: ts };
    }
  }
  return { toolName: name, success: false, error: `媒体处理需要 FFmpegKit 支持，当前版本暂不支持 ${p.op ?? name} 操作`, timestamp: ts };
}

// ─── Web Search Tool Execution ────────────────────────────────────────────────

/**
 * Tavily AI Search API
 * 专为 AI 优化，返回结构化摘要，每条结果包含 title/url/content/score
 * 文档：https://docs.tavily.com/api-reference
 */
async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<Array<{ title: string; url: string; content: string; score?: number }>> {
  if (!apiKey) throw new Error('Tavily API Key 未配置，请在工具设置中填写');

  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Tavily API 错误 ${resp.status}: ${err.substring(0, 200)}`);
  }

  const data = await resp.json() as {
    results: Array<{ title: string; url: string; content: string; score?: number }>;
  };
  return data.results ?? [];
}

/**
 * Exa AI Search API
 * 语义向量搜索，返回 title/url/text/highlights
 * 文档：https://docs.exa.ai/reference/search
 */
async function searchExa(
  query: string,
  maxResults: number,
  apiKey: string
): Promise<Array<{ title: string; url: string; content: string }>> {
  if (!apiKey) throw new Error('Exa API Key 未配置，请在工具设置中填写');

  const resp = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query,
      numResults: maxResults,
      type: 'auto',
      contents: { text: { maxCharacters: 500 } },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Exa API 错误 ${resp.status}: ${err.substring(0, 200)}`);
  }

  const data = await resp.json() as {
    results: Array<{ title: string; url: string; text?: string; highlights?: string[] }>;
  };
  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    content: r.text ?? (r.highlights ?? []).join(' ') ?? '',
  }));
}

/**
 * DuckDuckGo HTML 抓取（无需 API Key）
 */
async function searchDuckDuckGo(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; url: string; content: string }>> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Android 14; Mobile) AppleWebKit/537.36' },
  });
  const html = await resp.text();
  const results: Array<{ title: string; url: string; content: string }> = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{10,})<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < maxResults) {
    if (!m[1].includes('duckduckgo')) {
      results.push({ title: m[2].trim(), url: m[1], content: '' });
    }
  }
  return results;
}

/**
 * 百度搜索 HTML 抓取（无需 API Key）
 */
async function searchBaidu(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; url: string; content: string }>> {
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Android 14; Mobile) AppleWebKit/537.36' },
  });
  const html = await resp.text();
  const results: Array<{ title: string; url: string; content: string }> = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{10,})<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < maxResults) {
    if (!m[1].includes('baidu')) {
      results.push({ title: m[2].trim(), url: m[1], content: '' });
    }
  }
  return results;
}

async function execWebSearchTool(
  name: string,
  p: Record<string, unknown>,
  toolsConfig: ToolsConfig
): Promise<ToolResult> {
  const ts = Date.now();
  if (name !== 'search') return { toolName: name, success: false, error: `未知搜索工具: ${name}`, timestamp: ts };

  const query = p.q as string;
  const maxResults = Math.max(1, Math.min(20, (p.n as number) || toolsConfig.WebSearch.maxResults || 5));
  const engine: SearchEngine = toolsConfig.WebSearch.engine;

  try {
    let rawResults: Array<{ title: string; url: string; content: string; score?: number }>;

    switch (engine) {
      case 'tavily':
        rawResults = await searchTavily(query, maxResults, toolsConfig.WebSearch.tavilyApiKey);
        break;
      case 'exa':
        rawResults = await searchExa(query, maxResults, toolsConfig.WebSearch.exaApiKey);
        break;
      case 'baidu':
        rawResults = await searchBaidu(query, maxResults);
        break;
      case 'duckduckgo':
      default:
        rawResults = await searchDuckDuckGo(query, maxResults);
        break;
    }

    // 统一格式化结果（极简，节省 token）
    const results = rawResults.slice(0, maxResults).map((r, i) => ({
      i: i + 1,
      title: r.title.substring(0, 80),
      url: r.url,
      snippet: r.content ? r.content.substring(0, 200) : '',
    }));

    return {
      toolName: name,
      success: true,
      data: { query, engine, count: results.length, results },
      timestamp: ts,
    };
  } catch (e) {
    return { toolName: name, success: false, error: `搜索失败(${engine}): ${String(e)}`, timestamp: ts };
  }
}

// ─── Main Executor ────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  category: ToolCategory,
  parameters: Record<string, unknown>,
  toolsConfig: ToolsConfig
): Promise<ToolResult> {
  switch (category) {
    case 'Files':   return execFileTool(toolName, parameters);
    case 'Media':   return execMediaTool(toolName, parameters);
    case 'WebSearch': return execWebSearchTool(toolName, parameters, toolsConfig);
    default:        return { toolName, success: false, error: `未知工具类别: ${category}`, timestamp: Date.now() };
  }
}
