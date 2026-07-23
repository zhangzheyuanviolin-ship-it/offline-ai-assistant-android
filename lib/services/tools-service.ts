/**
 * 极简工具调用系统 - 专为手机端小模型优化
 *
 * 设计原则：
 * 1. 极简 JSON 格式：{"t":"工具名","p":{参数}} 最短触发
 * 2. 工具数量精简：合并相似功能，减少模型选择难度
 * 3. 系统提示极简：工具描述控制在 200 token 以内
 * 4. 参数名极短：path→p, content→c, query→q 等
 * 5. 工作区隔离：所有 Files/Media 操作限制在 workspaceDir 内，防止越权
 *
 * 搜索引擎：
 * - tavily: Tavily AI Search（专为 AI 优化，返回结构化摘要，需 API Key）
 * - exa: Exa AI Search（语义向量搜索，需 API Key）
 * - duckduckgo: DuckDuckGo HTML 抓取（无需 API Key）
 * - baidu: 百度搜索 HTML 抓取（无需 API Key，移动端 URL + 宽松匹配）
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
  { name: 'ls',    category: 'Files', desc: '列出目录内容',        params: { p: { t: 'str', d: '相对工作区的目录路径', req: true } }, dangerous: false },
  { name: 'cat',   category: 'Files', desc: '读取文件内容',        params: { p: { t: 'str', d: '相对工作区的文件路径', req: true }, n: { t: 'int', d: '最大字节数' } }, dangerous: false },
  { name: 'write', category: 'Files', desc: '写入文件',            params: { p: { t: 'str', d: '相对工作区的文件路径', req: true }, c: { t: 'str', d: '内容', req: true }, ow: { t: 'bool', d: '覆盖' } }, dangerous: true },
  { name: 'mkdir', category: 'Files', desc: '创建目录',            params: { p: { t: 'str', d: '相对工作区的目录路径', req: true } }, dangerous: false },
  { name: 'rm',    category: 'Files', desc: '删除文件或目录',      params: { p: { t: 'str', d: '相对工作区的路径', req: true } }, dangerous: true },
  { name: 'mv',    category: 'Files', desc: '移动或重命名文件',    params: { src: { t: 'str', d: '相对工作区的源路径', req: true }, dst: { t: 'str', d: '相对工作区的目标路径', req: true } }, dangerous: true },
  { name: 'zip',   category: 'Files', desc: '压缩/解压文件',       params: { p: { t: 'str', d: '相对工作区的输入路径', req: true }, o: { t: 'str', d: '相对工作区的输出路径', req: true }, mode: { t: 'str', d: 'zip或unzip', req: true } }, dangerous: false },
];

const MEDIA_TOOLS: ToolDef[] = [
  { name: 'media_info', category: 'Media', desc: '获取媒体文件信息',                           params: { p: { t: 'str', d: '相对工作区的媒体文件路径', req: true } }, dangerous: false },
  { name: 'media_proc', category: 'Media', desc: '处理媒体(提取音频/转码/裁剪/合并)', params: { op: { t: 'str', d: 'extract_audio|transcode|trim|merge', req: true }, p: { t: 'str', d: '相对工作区的输入路径', req: true }, o: { t: 'str', d: '相对工作区的输出路径', req: true }, args: { t: 'obj', d: '额外参数' } }, dangerous: false },
];

const WEB_TOOLS: ToolDef[] = [
  { name: 'search', category: 'WebSearch', desc: '搜索网络信息', params: { q: { t: 'str', d: '搜索词', req: true }, n: { t: 'int', d: '结果数' } }, dangerous: false },
];

const ALL_TOOLS = [...FILE_TOOLS, ...MEDIA_TOOLS, ...WEB_TOOLS];

// ─── Workspace Path Resolver ──────────────────────────────────────────────────

/**
 * 将模型给出的路径解析为绝对路径，并强制限制在 workspaceDir 之下。
 * - 绝对路径（以 / 开头）：直接使用，但仍需校验是否在 workspaceDir 下
 * - 相对路径：拼接 workspaceDir
 * 解析后禁止越过 workspaceDir，防止模型逃逸到系统目录。
 */
function resolveSafePath(inputPath: string, workspaceDir: string): string {
  let p = (inputPath || '').trim();
  if (!p) throw new Error('路径不能为空');
  if (p.startsWith('file://')) p = p.slice('file://'.length);

  const base = workspaceDir.replace(/\/+$/, '');
  let absolute: string;
  if (p.startsWith('/')) {
    absolute = p;
  } else {
    absolute = base + '/' + p;
  }

  // 规范化 .. 和 .
  const segments: string[] = [];
  for (const seg of absolute.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) {
        throw new Error(`路径越权：禁止访问工作区之外的目录 (${inputPath})`);
      }
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  const resolved = '/' + segments.join('/');
  if (!resolved.startsWith(base + '/') && resolved !== base) {
    throw new Error(`路径越权：禁止访问工作区之外的目录 (${inputPath})`);
  }
  return resolved;
}

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

const BUILD20_TOOLS_READY = true;

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) { objects.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return objects;
}

function normalizeToolCall(parsed: unknown, raw: string): ParsedToolCall | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const fn = value.function && typeof value.function === 'object' ? value.function as Record<string, unknown> : null;
  const toolName = typeof value.t === 'string' ? value.t
    : typeof value.tool === 'string' ? value.tool
    : typeof value.name === 'string' ? value.name
    : typeof fn?.name === 'string' ? fn.name : '';
  if (!toolName || !ALL_TOOLS.some((tool) => tool.name === toolName)) return null;
  let parameters: unknown = value.p ?? value.parameters ?? value.arguments ?? value.args ?? fn?.arguments ?? {};
  if (typeof parameters === 'string') {
    try { parameters = JSON.parse(parameters); } catch { return null; }
  }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) parameters = {};
  return { toolName, parameters: parameters as Record<string, unknown>, raw };
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const seen = new Set<string>();
  for (const raw of extractBalancedJsonObjects(text)) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    try {
      const call = normalizeToolCall(JSON.parse(raw), raw);
      if (call) results.push(call);
    } catch { /* prose braces are ignored */ }
  }
  return results;
}

export function buildNativeTools(toolsConfig: ToolsConfig): Array<Record<string, unknown>> {
  return getAvailableTools(toolsConfig).map((tool) => {
    const requiredEntries = Object.entries(tool.params).filter(([, spec]) => spec.req);
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.desc,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(requiredEntries.map(([name, spec]) => [name, {
            type: spec.t === 'int' ? 'integer' : spec.t === 'bool' ? 'boolean' : spec.t === 'obj' ? 'object' : 'string',
            description: spec.d,
          }])),
          required: requiredEntries.map(([name]) => name),
          additionalProperties: false,
        },
      },
    };
  });
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

async function execFileTool(
  name: string,
  p: Record<string, unknown>,
  workspaceDir: string
): Promise<ToolResult> {
  const ts = Date.now();
  try {
    switch (name) {
      case 'ls': {
        const path = resolveSafePath(p.p as string, workspaceDir);
        const files = await FileSystem.readDirectoryAsync(path);
        const details = await Promise.all(
          files.map(async (f) => {
            const info = await FileSystem.getInfoAsync(`${path}/${f}`);
            return { name: f, dir: info.isDirectory ?? false, size: (info as { size?: number }).size ?? 0 };
          })
        );
        return { toolName: name, success: true, data: { files: details, count: files.length, path }, timestamp: ts };
      }
      case 'cat': {
        const path = resolveSafePath(p.p as string, workspaceDir);
        const content = await FileSystem.readAsStringAsync(path);
        const maxBytes = (p.n as number) || 32768;
        const truncated = content.length > maxBytes;
        return { toolName: name, success: true, data: { content: truncated ? content.substring(0, maxBytes) + '\n...[截断]' : content, truncated }, timestamp: ts };
      }
      case 'write': {
        const path = resolveSafePath(p.p as string, workspaceDir);
        const info = await FileSystem.getInfoAsync(path);
        if (info.exists && !p.ow) throw new Error('文件已存在，设置 ow:true 以覆盖');
        await FileSystem.writeAsStringAsync(path, p.c as string);
        return { toolName: name, success: true, data: { path, bytes: (p.c as string).length }, timestamp: ts };
      }
      case 'mkdir': {
        const path = resolveSafePath(p.p as string, workspaceDir);
        await FileSystem.makeDirectoryAsync(path, { intermediates: true });
        return { toolName: name, success: true, data: { path }, timestamp: ts };
      }
      case 'rm': {
        const path = resolveSafePath(p.p as string, workspaceDir);
        await FileSystem.deleteAsync(path, { idempotent: true });
        return { toolName: name, success: true, data: { path }, timestamp: ts };
      }
      case 'mv': {
        const src = resolveSafePath(p.src as string, workspaceDir);
        const dst = resolveSafePath(p.dst as string, workspaceDir);
        await FileSystem.moveAsync({ from: src, to: dst });
        return { toolName: name, success: true, data: { src, dst }, timestamp: ts };
      }
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

async function execMediaTool(
  name: string,
  p: Record<string, unknown>,
  workspaceDir: string
): Promise<ToolResult> {
  const ts = Date.now();
  if (name === 'media_info') {
    try {
      const path = resolveSafePath(p.p as string, workspaceDir);
      const info = await FileSystem.getInfoAsync(path);
      return { toolName: name, success: true, data: { path, exists: info.exists, size: (info as { size?: number }).size ?? 0, isDir: info.isDirectory }, timestamp: ts };
    } catch (e) {
      return { toolName: name, success: false, error: String(e), timestamp: ts };
    }
  }
  // media_proc：当前版本仅做路径校验，真正的转码/裁剪需要 FFmpegKit。
  try {
    const path = resolveSafePath(p.p as string, workspaceDir);
    const out = p.o ? resolveSafePath(p.o as string, workspaceDir) : '';
    return {
      toolName: name,
      success: false,
      error: `媒体处理 (${p.op ?? name}) 需要 FFmpegKit 支持，当前版本暂未集成。已解析输入路径：${path}${out ? '，输出：' + out : ''}`,
      timestamp: ts,
    };
  } catch (e) {
    return { toolName: name, success: false, error: String(e), timestamp: ts };
  }
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
 * 使用 html.duckduckgo.com（lite 版），正则更宽松以提高命中率。
 */
const BUILD41_TOOL_ADAPTERS = true;

function decodeHtmlText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeDuckDuckGoLink(raw: string): string {
  let link = raw.replace(/&amp;/g, '&');
  if (link.startsWith('//')) link = 'https:' + link;
  const redirected = link.match(/[?&]uddg=([^&]+)/i)?.[1];
  if (redirected) {
    try { return decodeURIComponent(redirected); } catch { return redirected; }
  }
  return link;
}

function parseDuckDuckGoHtml(html: string, maxResults: number): Array<{ title: string; url: string; content: string }> {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const seen = new Set<string>();
  const anchor = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null && results.length < maxResults) {
    const url = decodeDuckDuckGoLink(match[1]);
    const title = decodeHtmlText(match[2]);
    if (!/^https?:\/\//i.test(url) || title.length < 3 || seen.has(url)) continue;
    const nearby = html.slice(match.index, Math.min(html.length, match.index + 2400));
    const snippetMatch = nearby.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    const snippet = snippetMatch ? decodeHtmlText(snippetMatch[1]) : '';
    if (/\$\{|\{\{|template|placeholder/i.test(title + ' ' + snippet)) continue;
    seen.add(url);
    results.push({ title: title.slice(0, 180), url, content: snippet.slice(0, 800) });
  }
  return results;
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; url: string; content: string }>> {
  const attempts: Array<() => Promise<Response>> = [
    () => fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      body: `q=${encodeURIComponent(query)}`,
    }),
    () => fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    }),
  ];

  let lastError = '';
  for (const attempt of attempts) {
    try {
      const response = await attempt();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      if (html.length < 500 || /captcha|anomaly-modal|verify you are human/i.test(html)) {
        throw new Error('搜索页面被拦截或返回空模板');
      }
      const parsed = parseDuckDuckGoHtml(html, maxResults);
      if (parsed.length > 0) return parsed;
      lastError = '页面返回成功，但没有解析到有效结果';
    } catch (error) {
      lastError = String(error);
    }
  }
  throw new Error(`DuckDuckGo 搜索失败：${lastError}`);
}

/**
 * 百度搜索 HTML 抓取（无需 API Key）
 * 使用移动端 m.baidu.com，结果结构稳定可解析。
 * 解析失败时自动 fallback 到 DuckDuckGo，确保模型一定能拿到结果。
 */
async function searchBaidu(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; url: string; content: string }>> {
  const url = `https://m.baidu.com/s?wd=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const html = await resp.text();
  const results: Array<{ title: string; url: string; content: string }> = [];

  // 百度移动端的结果 a 标签通常带 data-tools 或 class="c-show-url"
  const re = /<a[^>]+href="([^"]+)"[^>]*>([^<]{4,})<\/a>/gi;
  let m;
  const seen = new Set<string>();
  while ((m = re.exec(html)) !== null && results.length < maxResults) {
    let link = m[1];
    const title = m[2].trim();
    // 跳过百度内部链接与空标题
    if (!title) continue;
    if (link.includes('baidu.com') || link.startsWith('javascript:')) continue;
    if (link.startsWith('//')) link = 'https:' + link;
    if (seen.has(link)) continue;
    seen.add(link);
    results.push({ title: title.substring(0, 120), url: link, content: '' });
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

  const query = String(p.q ?? '').trim();
  if (!query) return { toolName: name, success: false, error: '搜索关键词不能为空', timestamp: ts };
  const maxResults = Math.max(1, Math.min(20, toolsConfig.WebSearch.maxResults || 5));
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

    const htmlEngine = engine === 'duckduckgo' || engine === 'baidu';
    const results = rawResults
      .slice(0, maxResults)
      .map((item, index) => ({
        i: index + 1,
        title: htmlEngine ? decodeHtmlText(String(item.title ?? '')).slice(0, 180) : String(item.title ?? '').trim().slice(0, 180),
        url: String(item.url ?? '').replace(/&amp;/g, '&'),
        snippet: htmlEngine ? decodeHtmlText(String(item.content ?? '')).slice(0, 800) : String(item.content ?? '').trim().slice(0, 1200),
        score: item.score,
      }))
      .filter((item) => item.title.length >= 3 && /^https?:\/\//i.test(item.url))
      .filter((item) => !htmlEngine || !/\$\{|\{\{|template|placeholder/i.test(item.title + ' ' + item.snippet));

    if (results.length === 0) {
      return { toolName: name, success: false, error: `${engine} 没有返回可用结果`, timestamp: ts };
    }

    const text = [
      `搜索关键词：${query}`,
      `搜索引擎：${engine}，结果：${results.length} 条`,
      ...results.map((item) => [
        `${item.i}. ${item.title}`,
        item.snippet ? `摘要：${item.snippet}` : '摘要：该搜索源未提供摘要。',
        `链接：${item.url}`,
      ].join('\n')),
    ].join('\n\n');

    return {
      toolName: name,
      success: true,
      data: { query, engine, count: results.length, results, text },
      timestamp: ts,
    };
  } catch (error) {
    return { toolName: name, success: false, error: `搜索失败(${engine}): ${String(error)}`, timestamp: ts };
  }
}

export function formatToolResultForModel(result: ToolResult): string {
  if (!result.success) return `错误：${result.error ?? '工具执行失败'}`;
  const data = result.data as { text?: unknown } | undefined;
  if (data && typeof data.text === 'string' && data.text.trim()) return data.text;
  try { return JSON.stringify(result.data ?? {}); } catch { return String(result.data ?? ''); }
}

// ─── Main Executor ────────────────────────────────────────────────────────────

export async function executeTool(
  toolName: string,
  category: ToolCategory,
  parameters: Record<string, unknown>,
  toolsConfig: ToolsConfig,
  workspaceDir: string
): Promise<ToolResult> {
  switch (category) {
    case 'Files':   return execFileTool(toolName, parameters, workspaceDir);
    case 'Media':   return execMediaTool(toolName, parameters, workspaceDir);
    case 'WebSearch': return execWebSearchTool(toolName, parameters, toolsConfig);
    default:        return { toolName, success: false, error: `未知工具类别: ${category}`, timestamp: Date.now() };
  }
}
