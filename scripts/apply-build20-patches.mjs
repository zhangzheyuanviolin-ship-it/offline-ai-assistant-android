import fs from 'node:fs';

const MARKER = 'BUILD20_PATCH_APPLIED';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
  console.log(`[build20] patched ${path}`);
}

function replaceOnce(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`[build20] target not found: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

function replaceRange(content, start, end, replacement, label) {
  if (content.includes(replacement)) return content;
  const startIndex = content.indexOf(start);
  if (startIndex < 0) throw new Error(`[build20] range start not found: ${label}`);
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`[build20] range end not found: ${label}`);
  return content.slice(0, startIndex) + replacement + content.slice(endIndex);
}

function patchToolsService() {
  const path = 'lib/services/tools-service.ts';
  let content = read(path);
  if (content.includes(`const ${MARKER}_TOOLS = true;`)) return;

  const parserStart = 'export function parseToolCalls(text: string): ParsedToolCall[] {';
  const parserEnd = '// ─── Tool Helpers';
  const replacement = `const ${MARKER}_TOOLS = true;

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
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function normalizeToolCall(parsed: unknown, raw: string): ParsedToolCall | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  const functionValue = value.function && typeof value.function === 'object'
    ? value.function as Record<string, unknown>
    : null;
  const toolName = typeof value.t === 'string'
    ? value.t
    : typeof value.tool === 'string'
      ? value.tool
      : typeof value.name === 'string'
        ? value.name
        : typeof functionValue?.name === 'string'
          ? functionValue.name
          : '';
  if (!toolName || !ALL_TOOLS.some((tool) => tool.name === toolName)) return null;

  let parameters: unknown = value.p ?? value.parameters ?? value.arguments ?? value.args ?? functionValue?.arguments ?? {};
  if (typeof parameters === 'string') {
    try { parameters = JSON.parse(parameters); } catch { return null; }
  }
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) parameters = {};
  return { toolName, parameters: parameters as Record<string, unknown>, raw };
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const seen = new Set<string>();
  const candidates = extractBalancedJsonObjects(text);

  for (const raw of candidates) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    try {
      const normalized = normalizeToolCall(JSON.parse(raw), raw);
      if (normalized) results.push(normalized);
    } catch {
      // A model may emit prose containing braces. Ignore only the invalid candidate.
    }
  }
  return results;
}

export function buildNativeTools(toolsConfig: ToolsConfig): Array<Record<string, unknown>> {
  return getAvailableTools(toolsConfig).map((tool) => {
    const properties = Object.fromEntries(
      Object.entries(tool.params).map(([name, spec]) => [name, {
        type: spec.t === 'int' ? 'integer' : spec.t === 'bool' ? 'boolean' : spec.t === 'obj' ? 'object' : 'string',
        description: spec.d,
      }])
    );
    const required = Object.entries(tool.params).filter(([, spec]) => spec.req).map(([name]) => name);
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.desc,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    };
  });
}

`;
  content = replaceRange(content, parserStart, parserEnd, replacement + parserEnd, 'balanced tool parser');
  write(path, content);
}

function patchChatScreen() {
  const path = 'app/(tabs)/index.tsx';
  let content = read(path);
  if (content.includes(`const ${MARKER}_CHAT = true;`)) return;

  content = replaceOnce(
    content,
    '  buildCompactSystemPrompt,\n',
    '  buildCompactSystemPrompt,\n  buildNativeTools,\n',
    'native tools import'
  );

  content = replaceOnce(
    content,
    '  const toolPrompt = buildCompactSystemPrompt(toolsConfig);\n  const systemContent = `你是一个离线 AI 助手，运行在用户手机上。简洁回答，必要时调用工具。${toolPrompt}`;',
    `  const nativeTools = buildNativeTools(toolsConfig);\n  const toolPrompt = nativeTools.length === 0 ? '' : '\\n需要外部信息或文件操作时调用工具，不要伪造工具结果。';\n  const systemContent = \`你是一个离线 AI 助手，运行在用户手机上。简洁回答，必要时调用工具。\${toolPrompt}\`;`,
    'compact native tool prompt'
  );

  const oldCompletion = `    await ctx.completion(
      {
        messages: msgs as Parameters<typeof ctx.completion>[0]['messages'],
        n_predict: inferenceParams.max_tokens,
        temperature: inferenceParams.temperature,
        top_p: inferenceParams.top_p,
        top_k: inferenceParams.top_k,
        penalty_repeat: inferenceParams.repeat_penalty,
        stop: [...safeStop, '{"t":', '\`\`\`json'],
      },
      (data: { token: string }) => {
        const tok = data.token ?? '';
        if (!tok) return;
        // 过滤控制字符（thinking 标签、特殊符号）
        const visible = tok.replace(/<\\|[^|]+?\\|>/g, '');
        if (visible.length === 0) return;
        roundText += visible;
        if (toolCallRound === 0) {
          fullResponse += visible;
          tokenCount++;
          if (tokenCount % 10 === 0 || tokenCount === 1) {
            onActivity('streaming', \`已生成 \${tokenCount} 个 token...\`);
          }
          pushToken(visible);
        }
      }
    );`;

  const newCompletion = `    const completionResult = await ctx.completion(
      {
        messages: msgs as Parameters<typeof ctx.completion>[0]['messages'],
        n_predict: inferenceParams.max_tokens,
        temperature: inferenceParams.temperature,
        top_p: inferenceParams.top_p,
        top_k: inferenceParams.top_k,
        penalty_repeat: inferenceParams.repeat_penalty,
        stop: safeStop,
        tools: nativeTools,
        tool_choice: nativeTools.length > 0 ? 'auto' : undefined,
      } as Parameters<typeof ctx.completion>[0] & { tools?: Array<Record<string, unknown>>; tool_choice?: 'auto' },
      (data: { token?: string; content?: string; reasoning_content?: string }) => {
        const tok = data.token ?? data.content ?? data.reasoning_content ?? '';
        if (!tok) return;
        const visible = tok.replace(/<\\|[^|]+?\\|>/g, '');
        if (visible.length === 0) return;
        roundText += visible;
        if (toolCallRound === 0) {
          fullResponse += visible;
          tokenCount++;
          if (tokenCount % 10 === 0 || tokenCount === 1) {
            onActivity('streaming', \`已生成 \${tokenCount} 个 token...\`);
          }
          pushToken(visible);
        }
      }
    );`;
  content = replaceOnce(content, oldCompletion, newCompletion, 'native completion tool call');

  content = replaceOnce(
    content,
    '    const toolCalls = parseToolCalls(roundText);\n    if (toolCalls.length === 0) break;',
    `    const rawNativeCalls = (completionResult as unknown as { tool_calls?: unknown[]; toolCalls?: unknown[] }).tool_calls\n      ?? (completionResult as unknown as { toolCalls?: unknown[] }).toolCalls\n      ?? [];\n    const nativeCalls = Array.isArray(rawNativeCalls)\n      ? rawNativeCalls.map((entry) => {\n          const value = entry as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };\n          const toolName = value.name ?? value.function?.name ?? '';\n          let parameters = value.arguments ?? value.function?.arguments ?? {};\n          if (typeof parameters === 'string') {\n            try { parameters = JSON.parse(parameters); } catch { parameters = {}; }\n          }\n          return { toolName, parameters: parameters as Record<string, unknown>, raw: JSON.stringify(entry) };\n        }).filter((entry) => entry.toolName)\n      : [];\n    const toolCalls = nativeCalls.length > 0 ? nativeCalls : parseToolCalls(roundText);\n    if (toolCalls.length === 0) break;\n\n    // Tool protocol is control data, not assistant prose. Remove it from persisted final text.\n    for (const call of parseToolCalls(roundText)) {\n      fullResponse = fullResponse.replace(call.raw, '');\n    }\n    fullResponse = fullResponse.replace(/<\\/?tool_call>/g, '').trimEnd();`,
    'native and fallback tool call extraction'
  );

  const parserStart = 'interface ParsedContent {';
  const parserEnd = '// ─── Activity Message';
  const parserReplacement = `const ${MARKER}_CHAT = true;

interface ParsedContent {
  thinking: string;
  response: string;
}

function parseThinkingTags(text: string): ParsedContent {
  const normalized = text.replace(/<\\|[^|]+?\\|>/g, '');
  const complete = normalized.match(/<(?:think|thinking)>([\\s\\S]*?)<\\/(?:think|thinking)>/i);
  if (complete) {
    return {
      thinking: complete[1].trim(),
      response: normalized.replace(complete[0], '').trim(),
    };
  }

  // Some Qwen chat templates prefill the opening tag and only generate </think>.
  const closingOnly = normalized.search(/<\\/(?:think|thinking)>/i);
  if (closingOnly >= 0) {
    const closing = normalized.match(/<\\/(?:think|thinking)>/i)?.[0] ?? '</think>';
    return {
      thinking: normalized.slice(0, closingOnly).trim(),
      response: normalized.slice(closingOnly + closing.length).trim(),
    };
  }

  const open = normalized.match(/<(?:think|thinking)>([\\s\\S]*)$/i);
  if (open) return { thinking: open[1].trim(), response: '' };
  return { thinking: '', response: normalized.trim() };
}

`;
  content = replaceRange(content, parserStart, parserEnd, parserReplacement + parserEnd, 'thinking parser');

  // Do not merge an entire assistant bubble into one accessibility node; keep toggle and answer separately focusable.
  content = content.replace(/(style=\{\[styles\.msgRow,[\\s\\S]*?\}\}\n)\s*accessible\n\s*accessibilityLabel=\{`\\$\{isUser \? '您' : 'AI'\}：\\$\{response \|\| item\.content\}`\}\n\s*accessibilityRole="text"/m, '$1');
  content = content.replace(
    '<View style={[styles.msgRow, styles.msgRowAssistant]} accessible accessibilityLabel={`AI：${response || content || activityText}`} accessibilityRole="text">',
    '<View style={[styles.msgRow, styles.msgRowAssistant]}>'
  );
  content = content.replace(
    '          selectable\n        >\n          {response || item.content}',
    '          selectable\n          accessible\n          accessibilityRole="text"\n          accessibilityLabel={`${isUser ? \'您\' : \'最终回答\'}：${response || item.content}`}\n        >\n          {response || item.content}'
  );
  content = content.replace(
    '            selectable\n          >\n            {response || \'\'}',
    '            selectable\n            accessible\n            accessibilityRole="text"\n            accessibilityLabel={`最终回答：${response || \'尚未生成正文\'}`}\n          >\n            {response || \'\'}'
  );

  write(path, content);
}

function patchModelImport() {
  const path = 'lib/services/model-service.ts';
  let content = read(path);
  if (content.includes(`const ${MARKER}_MODEL_IMPORT = true;`)) return;
  content = replaceOnce(
    content,
    "const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;",
    "const MODELS_DIR = `${FileSystem.documentDirectory}ai-models/`;\nconst BUILD20_PATCH_APPLIED_MODEL_IMPORT = true;",
    'model import marker'
  );
  content = replaceOnce(content, '    copyToCacheDirectory: true,', '    copyToCacheDirectory: false,', 'disable picker cache copy');
  content = content.replace(
    '  // 当前 Expo DocumentPicker 会先生成缓存副本。这里保留兼容路径，\n  // 但在复制失败时主动清理不完整目标，避免留下损坏模型。',
    '  // build20: request the original provider URI and perform exactly one managed copy.\n  // This avoids the picker cache + app model directory double-copy for very large GGUF files.'
  );
  content = content.replace(
    "    throw error;",
    "    throw new Error(`模型单次导入失败。请确认文件来自本机可直接读取的文件夹，而不是云盘占位文件。原始错误：${String(error)}`);"
  );
  write(path, content);
}

patchToolsService();
patchChatScreen();
patchModelImport();
console.log('[build20] all patches applied');
