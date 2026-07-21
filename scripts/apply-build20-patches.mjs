import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content, 'utf8'); console.log(`[build20] patched ${path}`); }
function mustReplace(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  if (!content.includes(search)) throw new Error(`[build20] target not found: ${label}`);
  return content.replace(search, replacement);
}

function patchToolsService() {
  const path = 'lib/services/tools-service.ts';
  let content = read(path);
  if (content.includes('BUILD20_TOOLS_READY')) return;
  const start = content.indexOf('export function parseToolCalls(text: string): ParsedToolCall[] {');
  const end = content.indexOf('// ─── Tool Helpers', start);
  if (start < 0 || end < 0) throw new Error('[build20] parser block not found');
  const block = `const BUILD20_TOOLS_READY = true;

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
      else if (ch === '\\\\') escaped = true;
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
  return getAvailableTools(toolsConfig).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.desc,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(tool.params).map(([name, spec]) => [name, {
          type: spec.t === 'int' ? 'integer' : spec.t === 'bool' ? 'boolean' : spec.t === 'obj' ? 'object' : 'string',
          description: spec.d,
        }])),
        required: Object.entries(tool.params).filter(([, spec]) => spec.req).map(([name]) => name),
        additionalProperties: false,
      },
    },
  }));
}

`;
  content = content.slice(0, start) + block + content.slice(end);
  write(path, content);
}

function patchChat() {
  const path = 'app/(tabs)/index.tsx';
  let content = read(path);
  if (content.includes('BUILD20_CHAT_READY')) return;
  content = mustReplace(content, '  buildCompactSystemPrompt,\n', '  buildCompactSystemPrompt,\n  buildNativeTools,\n', 'tool import');
  content = mustReplace(
    content,
    '  const toolPrompt = buildCompactSystemPrompt(toolsConfig);\n  const systemContent = `你是一个离线 AI 助手，运行在用户手机上。简洁回答，必要时调用工具。${toolPrompt}`;',
    "  const nativeTools = buildNativeTools(toolsConfig);\n  const toolPrompt = nativeTools.length === 0 ? '' : '\\n需要外部信息或文件操作时调用工具，不要伪造工具结果。';\n  const systemContent = `你是一个离线 AI 助手，运行在用户手机上。简洁回答，必要时调用工具。${toolPrompt}`;",
    'system prompt'
  );
  content = mustReplace(content, '    await ctx.completion(\n', '    const completionResult = await ctx.completion(\n', 'completion result binding');
  content = mustReplace(
    content,
    "        stop: [...safeStop, '{\"t\":', '```json'],\n",
    "        stop: safeStop,\n        tools: nativeTools,\n        tool_choice: nativeTools.length > 0 ? 'auto' : undefined,\n",
    'native tool params'
  );
  content = mustReplace(
    content,
    '      },\n      (data: { token: string }) => {\n        const tok = data.token ?? \'\';',
    "      } as Parameters<typeof ctx.completion>[0] & { tools?: Array<Record<string, unknown>>; tool_choice?: 'auto' },\n      (data: { token?: string; content?: string; reasoning_content?: string }) => {\n        const tok = data.token ?? data.content ?? data.reasoning_content ?? '';",
    'native callback fields'
  );
  content = mustReplace(
    content,
    '    const toolCalls = parseToolCalls(roundText);\n    if (toolCalls.length === 0) break;',
    `    const rawNativeCalls = (completionResult as unknown as { tool_calls?: unknown[]; toolCalls?: unknown[] }).tool_calls
      ?? (completionResult as unknown as { toolCalls?: unknown[] }).toolCalls
      ?? [];
    const nativeCalls = Array.isArray(rawNativeCalls)
      ? rawNativeCalls.map((entry) => {
          const value = entry as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };
          const toolName = value.name ?? value.function?.name ?? '';
          let parameters = value.arguments ?? value.function?.arguments ?? {};
          if (typeof parameters === 'string') {
            try { parameters = JSON.parse(parameters); } catch { parameters = {}; }
          }
          return { toolName, parameters: parameters as Record<string, unknown>, raw: JSON.stringify(entry) };
        }).filter((entry) => entry.toolName)
      : [];
    const fallbackCalls = parseToolCalls(roundText);
    const toolCalls = nativeCalls.length > 0 ? nativeCalls : fallbackCalls;
    if (toolCalls.length === 0) break;
    for (const call of fallbackCalls) fullResponse = fullResponse.replace(call.raw, '');
    fullResponse = fullResponse.replace(/<\\/?tool_call>/g, '').trimEnd();`,
    'tool call extraction'
  );
  const pStart = content.indexOf('interface ParsedContent {');
  const pEnd = content.indexOf('// ─── Activity Message', pStart);
  if (pStart < 0 || pEnd < 0) throw new Error('[build20] thinking parser block not found');
  const parser = `const BUILD20_CHAT_READY = true;

interface ParsedContent { thinking: string; response: string; }

function parseThinkingTags(text: string): ParsedContent {
  const normalized = text.replace(/<\\|[^|]+?\\|>/g, '');
  const complete = normalized.match(/<(?:think|thinking)>([\\s\\S]*?)<\\/(?:think|thinking)>/i);
  if (complete) return { thinking: complete[1].trim(), response: normalized.replace(complete[0], '').trim() };
  const closing = normalized.match(/<\\/(?:think|thinking)>/i);
  if (closing && closing.index !== undefined) {
    return { thinking: normalized.slice(0, closing.index).trim(), response: normalized.slice(closing.index + closing[0].length).trim() };
  }
  const open = normalized.match(/<(?:think|thinking)>([\\s\\S]*)$/i);
  if (open) return { thinking: open[1].trim(), response: '' };
  return { thinking: '', response: normalized.trim() };
}

`;
  content = content.slice(0, pStart) + parser + content.slice(pEnd);
  content = content.replace(
    '<View style={[styles.msgRow, styles.msgRowAssistant]} accessible accessibilityLabel={`AI：${response || content || activityText}`} accessibilityRole="text">',
    '<View style={[styles.msgRow, styles.msgRowAssistant]}>'
  );
  content = content.replace(/\n\s*accessible\n\s*accessibilityLabel=\{`\$\{isUser \? '您' : 'AI'\}：\$\{response \|\| item\.content\}`\}\n\s*accessibilityRole="text"/, '');
  content = content.replace(
    '          selectable\n        >\n          {response || item.content}',
    '          selectable\n          accessible\n          accessibilityRole="text"\n          accessibilityLabel={`${isUser ? \'您\' : \'最终回答\'}：${response || item.content}`}\n        >\n          {response || item.content}'
  );
  content = content.replace(
    "            selectable\n          >\n            {response || ''}",
    "            selectable\n            accessible\n            accessibilityRole=\"text\"\n            accessibilityLabel={`最终回答：${response || '尚未生成正文'}`}\n          >\n            {response || ''}"
  );
  write(path, content);
}

function patchModelImport() {
  const path = 'lib/services/model-service.ts';
  let content = read(path);
  if (content.includes('BUILD20_MODEL_IMPORT_READY')) return;
  content = mustReplace(content, "const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;", "const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;\nconst BUILD20_MODEL_IMPORT_READY = true;", 'model marker');
  content = mustReplace(content, '    copyToCacheDirectory: true,', '    copyToCacheDirectory: false,', 'single-copy picker');
  write(path, content);
}

patchToolsService();
patchChat();
patchModelImport();
console.log('[build20] all patches applied');
