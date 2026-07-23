import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content, 'utf8');
  console.log(`[build22] patched ${path}`);
}

function replaceOnce(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`[build22] target not found: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

function replaceRange(content, start, end, replacement, label) {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) throw new Error(`[build22] range start not found: ${label}`);
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`[build22] range end not found: ${label}`);
  return content.slice(0, startIndex) + replacement + content.slice(endIndex);
}

function patchTypes() {
  const path = 'lib/types.ts';
  let content = read(path);
  if (content.includes('BUILD22_MEMORY_CONTROLS')) return;

  content = replaceOnce(
    content,
    '  n_batch: number;\n  n_threads: number;\n  n_gpu_layers: number;\n',
    '  n_batch: number;\n  n_ubatch: number;\n  n_threads: number;\n  n_gpu_layers: number;\n  use_mmap: boolean;\n  use_mlock: boolean;\n  large_model_safe_mode: boolean;\n',
    'inference memory fields'
  );
  content = replaceOnce(
    content,
    '  n_batch: 256,\n  n_threads: 4,\n  n_gpu_layers: 0,\n',
    '  n_batch: 256,\n  n_ubatch: 64,\n  n_threads: 4,\n  n_gpu_layers: 0,\n  use_mmap: true,\n  use_mlock: false,\n  large_model_safe_mode: true,\n',
    'default memory values'
  );
  content = content.replace(
    '/**\n * 核心类型定义 - Offline AI Assistant',
    '/**\n * BUILD22_MEMORY_CONTROLS\n * 核心类型定义 - Offline AI Assistant'
  );
  write(path, content);
}

function patchModelService() {
  const path = 'lib/services/model-service.ts';
  let content = read(path);
  if (content.includes('BUILD22_LARGE_MODEL_SAFE_PROFILE')) return;

  const diagnosticsStart = '      if (callback) {\n        const summary =';
  const diagnosticsEnd = '\n\n      return result;';
  const startIndex = content.indexOf(diagnosticsStart);
  if (startIndex < 0) throw new Error('[build22] diagnostics callback block not found');
  const endIndex = content.indexOf(diagnosticsEnd, startIndex);
  if (endIndex < 0) throw new Error('[build22] diagnostics callback end not found');
  content = content.slice(0, startIndex)
    + '      // BUILD22: diagnostics stay out-of-band in _lastDiagnostics and never enter model text.\n'
    + content.slice(endIndex);

  const initStart = '  const context = await initLlama(\n    {\n      model: model.filePath,';
  const initEnd = '    (progress) => {';
  const initReplacement = `  // BUILD22_LARGE_MODEL_SAFE_PROFILE
  // Sparse MoE still maps every expert weight. On 24 GB Android devices the critical
  // headroom is compute/KV buffers, so large files receive conservative defaults.
  const largeModel = model.fileSize >= 12 * 1024 * 1024 * 1024;
  const safeLargeModel = largeModel && params.large_model_safe_mode;
  const effectiveCtx = safeLargeModel ? Math.min(params.n_ctx, 2048) : params.n_ctx;
  const effectiveBatch = safeLargeModel ? Math.min(params.n_batch, 64) : params.n_batch;
  const requestedUbatch = Math.max(1, params.n_ubatch || Math.min(params.n_batch, 64));
  const effectiveUbatch = safeLargeModel ? Math.min(requestedUbatch, 32) : Math.min(requestedUbatch, effectiveBatch);
  const effectiveGpuLayers = safeLargeModel ? 0 : params.n_gpu_layers;

  const context = await initLlama(
    {
      model: model.filePath,
      n_ctx: effectiveCtx,
      n_batch: effectiveBatch,
      n_ubatch: effectiveUbatch,
      n_threads: params.n_threads,
      n_gpu_layers: effectiveGpuLayers,
      use_mlock: safeLargeModel ? false : params.use_mlock,
      use_mmap: params.use_mmap,
      n_parallel: 1,
      kv_unified: true,
      flash_attn_type: 'off',
      ...(safeLargeModel ? { cache_type_k: 'q8_0', cache_type_v: 'q8_0' } : {}),
      no_extra_bufts: true,
    } as Parameters<typeof initLlama>[0],
`;
  content = replaceRange(content, initStart, initEnd, initReplacement + initEnd, 'safe model initialization');
  write(path, content);
}

function patchToolsService() {
  const path = 'lib/services/tools-service.ts';
  let content = read(path);
  if (content.includes('BUILD22_SEARCH_RESULTS_READY')) return;

  const nativeStart = 'export function buildNativeTools(toolsConfig: ToolsConfig): Array<Record<string, unknown>> {';
  const nativeEnd = '\n\n// ─── Tool Helpers';
  const nativeReplacement = `export function buildNativeTools(toolsConfig: ToolsConfig): Array<Record<string, unknown>> {
  return getAvailableTools(toolsConfig).map((tool) => {
    // Mobile models only fill indispensable arguments. Optional defaults live in settings.
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
}`;
  content = replaceRange(content, nativeStart, nativeEnd, nativeReplacement + nativeEnd, 'minimal native tools');

  const ddgStart = 'async function searchDuckDuckGo(';
  const ddgEnd = '/**\n * 百度搜索 HTML 抓取';
  const ddgReplacement = `const BUILD22_SEARCH_RESULTS_READY = true;

function decodeHtmlText(input: string): string {
  return input
    .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
    .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\\s+/g, ' ')
    .trim();
}

function decodeDuckDuckGoLink(raw: string): string {
  let link = raw.replace(/&amp;/g, '&');
  if (link.startsWith('//')) link = 'https:' + link;
  const redirect = link.match(/[?&]uddg=([^&]+)/i)?.[1];
  if (redirect) {
    try { return decodeURIComponent(redirect); } catch { return redirect; }
  }
  return link;
}

function parseDuckDuckGoHtml(
  html: string,
  maxResults: number
): Array<{ title: string; url: string; content: string }> {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const blocks = html.split(/<div[^>]+class=["'][^"']*results_links[^"']*["'][^>]*>/i).slice(1);

  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const linkMatch = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/i)
      ?? block.match(/<a[^>]+href=["']([^"']+)["'][^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>/i);
    if (!linkMatch) continue;
    const title = decodeHtmlText(linkMatch[2]);
    const url = decodeDuckDuckGoLink(linkMatch[1]);
    const snippetMatch = block.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:a|div)>/i);
    const snippet = snippetMatch ? decodeHtmlText(snippetMatch[1]) : '';
    if (!/^https?:\\/\\//i.test(url) || title.length < 3) continue;
    if (/\\$\\{|\\{\\{|template|placeholder/i.test(title + ' ' + snippet)) continue;
    results.push({ title: title.slice(0, 160), url, content: snippet.slice(0, 500) });
  }
  return results;
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number
): Promise<Array<{ title: string; url: string; content: string }>> {
  const endpoints = [
    \`https://html.duckduckgo.com/html/?q=\${encodeURIComponent(query)}\`,
    \`https://lite.duckduckgo.com/lite/?q=\${encodeURIComponent(query)}\`,
  ];
  let lastError = '';

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      if (!resp.ok) throw new Error(\`HTTP \${resp.status}\`);
      const html = await resp.text();
      if (html.length < 500 || /captcha|anomaly-modal|verify you are human/i.test(html)) {
        throw new Error('搜索页面被拦截或返回空模板');
      }
      const parsed = parseDuckDuckGoHtml(html, maxResults);
      if (parsed.length > 0) return parsed;
      lastError = '页面已返回，但没有解析到有效结果';
    } catch (error) {
      lastError = String(error);
    }
  }
  throw new Error(\`DuckDuckGo 解析失败：\${lastError}\`);
}

`;
  content = replaceRange(content, ddgStart, ddgEnd, ddgReplacement + ddgEnd, 'DuckDuckGo parser');

  content = replaceOnce(
    content,
    '  const maxResults = Math.max(1, Math.min(20, (p.n as number) || toolsConfig.WebSearch.maxResults || 5));',
    '  const maxResults = Math.max(1, Math.min(10, toolsConfig.WebSearch.maxResults || 5));',
    'search result count from settings'
  );

  const formatStart = '    // 统一格式化结果（极简，节省 token）';
  const formatEnd = '    if (results.length === 0) {';
  const formatReplacement = `    // BUILD22: reject empty/template entries and provide compact natural-language evidence.
    const results = rawResults
      .slice(0, maxResults)
      .map((r, i) => ({
        i: i + 1,
        title: decodeHtmlText(String(r.title ?? '')).slice(0, 120),
        url: String(r.url ?? '').replace(/&amp;/g, '&'),
        snippet: decodeHtmlText(String(r.content ?? '')).slice(0, 360),
      }))
      .filter((r) => r.title.length >= 3 && /^https?:\\/\\//i.test(r.url))
      .filter((r) => !/\\$\\{|\\{\\{|template|placeholder/i.test(r.title + ' ' + r.snippet));

    const text = [
      \`搜索关键词：\${query}\`,
      \`搜索引擎：\${engine}，有效结果：\${results.length} 条\`,
      ...results.map((r) => [
        \`\${r.i}. \${r.title}\`,
        r.snippet ? \`摘要：\${r.snippet}\` : '摘要：搜索页未提供摘要，请仅依据标题和链接谨慎回答。',
        \`链接：\${r.url}\`,
      ].join('\\n')),
    ].join('\\n\\n');

`;
  content = replaceRange(content, formatStart, formatEnd, formatReplacement + formatEnd, 'search result formatting');
  content = replaceOnce(
    content,
    '      data: { query, engine, count: results.length, results },',
    '      data: { query, engine, count: results.length, results, text },',
    'model-ready search text'
  );
  write(path, content);
}

function patchChat() {
  const path = 'app/(tabs)/index.tsx';
  let content = read(path);
  if (content.includes('BUILD22_TOOL_LOOP_READY')) return;

  content = replaceOnce(
    content,
    'import { ChatMessage, ToolCall, ToolLog } from \'@/lib/types\';',
    'import { ChatMessage, ToolCall, ToolLog, ToolResult } from \'@/lib/types\';',
    'ToolResult import'
  );

  content = replaceOnce(
    content,
    '  const nativeTools = buildNativeTools(toolsConfig);\n',
    `  const configuredNativeTools = buildNativeTools(toolsConfig);
  // Do not pay the schema-prefill cost in ordinary chat. Select only the likely category.
  const wantsWeb = /(搜索|查找|联网|新闻|最新|网页|资料|search|web)/i.test(userText);
  const wantsFiles = /(文件|目录|读取|写入|保存|删除|重命名|压缩|解压|file|folder)/i.test(userText);
  const wantsMedia = /(音频|视频|媒体|转码|裁剪|提取音频|media|audio|video)/i.test(userText);
  const nativeTools = configuredNativeTools.filter((tool) => {
    const name = String((tool.function as { name?: string } | undefined)?.name ?? '');
    if (name === 'search') return wantsWeb;
    if (name.startsWith('media_')) return wantsMedia;
    return wantsFiles;
  });
`,
    'prompt-aware tool selection'
  );
  content = replaceOnce(content, '  const MAX_TOOL_ROUNDS = 3;', '  const MAX_TOOL_ROUNDS = 2;', 'tool round cap');

  const loopStart = '  while (toolCallRound <= MAX_TOOL_ROUNDS) {';
  const loopEnd = "  onActivity('streaming', `生成完成（${tokenCount} tokens）`);";
  const loopReplacement = `  const seenToolCalls = new Set<string>();
  const BUILD22_TOOL_LOOP_READY = true;

  while (toolCallRound <= MAX_TOOL_ROUNDS) {
    let roundText = '';
    let roundReasoning = '';
    let roundTokenCount = 0;
    const roundTools = toolCallRound < MAX_TOOL_ROUNDS ? nativeTools : [];

    onActivity('streaming', '模型正在生成...');

    // eslint-disable-next-line no-await-in-loop
    const completionResult = await ctx.completion(
      {
        messages: msgs as Parameters<typeof ctx.completion>[0]['messages'],
        n_predict: inferenceParams.max_tokens,
        temperature: inferenceParams.temperature,
        top_p: inferenceParams.top_p,
        top_k: inferenceParams.top_k,
        penalty_repeat: inferenceParams.repeat_penalty,
        stop: safeStop,
        tools: roundTools,
        tool_choice: roundTools.length > 0 ? 'auto' : undefined,
        chat_template_kwargs: { preserve_thinking: true },
      } as Parameters<typeof ctx.completion>[0] & {
        tools?: Array<Record<string, unknown>>;
        tool_choice?: 'auto';
        chat_template_kwargs?: Record<string, unknown>;
      },
      (data: { token?: string; content?: string; reasoning_content?: string }) => {
        const reasoningPart = data.reasoning_content ?? '';
        if (reasoningPart) roundReasoning += reasoningPart.replace(/<\\|[^|]+?\\|>/g, '');
        const raw = data.content ?? data.token ?? '';
        if (!raw) return;
        const visible = raw.replace(/<\\|[^|]+?\\|>/g, '');
        if (!visible) return;
        roundText += visible;
        roundTokenCount += 1;
        if (roundTokenCount === 1 || roundTokenCount % 20 === 0) {
          onActivity('streaming', \`本轮已生成 \${roundTokenCount} 个 token...\`);
        }
      }
    );

    tokenCount += roundTokenCount;
    const resultObject = completionResult as unknown as {
      text?: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
      toolCalls?: unknown[];
    };
    if (!roundText.trim() && resultObject.text) roundText = resultObject.text;
    if (!roundReasoning.trim() && resultObject.reasoning_content) roundReasoning = resultObject.reasoning_content;

    const rawNativeCalls = resultObject.tool_calls ?? resultObject.toolCalls ?? [];
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
    const parsedCalls = nativeCalls.length > 0 ? nativeCalls : fallbackCalls;

    if (parsedCalls.length === 0) {
      let cleanText = roundText;
      for (const call of fallbackCalls) cleanText = cleanText.replace(call.raw, '');
      cleanText = cleanText.replace(/<\\/?tool_call>/g, '').trim();
      const reasoning = roundReasoning.trim();
      fullResponse = reasoning
        ? \`<think>\${reasoning}</think>\\n\${cleanText}\`.trim()
        : cleanText;
      if (fullResponse) pushToken(fullResponse);
      break;
    }

    const toolCalls = parsedCalls.filter((call) => {
      const key = \`\${call.toolName}:\${JSON.stringify(call.parameters)}\`;
      if (seenToolCalls.has(key)) return false;
      seenToolCalls.add(key);
      return true;
    });

    if (toolCalls.length === 0) {
      toolCallRound = MAX_TOOL_ROUNDS;
      msgs.push({ role: 'user', content: '相同工具和参数已经执行过。请停止重复调用，直接根据现有结果回答。' });
      continue;
    }

    toolCallRound += 1;
    const names = toolCalls.map((t) => t.toolName).join(', ');
    onActivity('tool_calling', \`正在调用工具：\${names}...\`);

    const toolResults: string[] = [];
    for (const tc of toolCalls) {
      const category = getToolCategory(tc.toolName) ?? 'Files';
      const toolCall: ToolCall = {
        id: \`tc_\${Date.now()}_\${tc.toolName}\`,
        toolName: tc.toolName,
        toolCategory: category,
        parameters: tc.parameters,
        status: 'pending',
      };
      // eslint-disable-next-line no-await-in-loop
      const resultStr = await onToolCall(toolCall);
      toolResults.push(\`[\${tc.toolName} 真实执行结果]\\n\${resultStr}\`);
    }

    onActivity('tool_done', '工具已返回有效结果');
    const toolResultContent = toolResults.join('\\n\\n');
    msgs.push({ role: 'assistant', content: roundText || \`调用工具：\${names}\` });
    msgs.push({
      role: 'user',
      content: \`以下是工具刚刚返回的真实数据，不是模板。\\n\\n\${toolResultContent}\\n\\n请直接依据这些数据回答用户；不要虚构，不要再次调用相同工具。若资料不足，明确说明不足。\`,
    });
  }

  if (!fullResponse.trim()) {
    fullResponse = '工具执行完成，但模型没有生成最终回答。请稍后重试或更换搜索引擎。';
    pushToken(fullResponse);
  }

`;
  content = replaceRange(content, loopStart, loopEnd, loopReplacement + loopEnd, 'tool execution loop');

  const activityMarker = '// ─── Chat Screen ─────────────────────────────────────────────────────────────';
  const resultFormatter = `function formatToolResultForModel(result: ToolResult): string {
  if (!result.success) return \`错误：\${result.error ?? '工具执行失败'}\`;
  const data = result.data as { text?: unknown } | undefined;
  if (data && typeof data.text === 'string' && data.text.trim()) return data.text;
  try { return JSON.stringify(result.data ?? {}); } catch { return String(result.data ?? ''); }
}

`;
  content = replaceOnce(content, activityMarker, resultFormatter + activityMarker, 'tool result formatter');
  content = content.replace(
    /resolve\(result\.success \? JSON\.stringify\(result\.data\) : `错误: \$\{result\.error\}`\);/g,
    'resolve(formatToolResultForModel(result));'
  );

  // Make the thinking button a real independent touch/accessibility target.
  content = content.replace(/\n n\s+onPress=/g, '\n              onPress=');
  content = content.replace(/\n\s*n\s+onPress=/g, '\n              onPress=');
  content = content.replace(
    'onPress={() => setShowThinking(!showThinking)}',
    'onPress={() => setShowThinking((value) => !value)}'
  );
  content = content.replace(
    /accessibilityLabel=\{`\$\{showThinking \? '[^']+' : '[^']+'\}思考过程`\}\n\s+style=\{styles\.thinkingToggle\}/g,
    (match) => match.replace('style={styles.thinkingToggle}', 'accessibilityState={{ expanded: showThinking }}\n              importantForAccessibility="yes"\n              style={styles.thinkingToggle}')
  );
  content = content.replace(
    /(<View\n\s+style=\{\[styles\.msgRow, isUser \? styles\.msgRowUser : styles\.msgRowAssistant\]\})\n\s+accessible\n\s+accessibilityLabel=\{[^\n]+\}\n\s+accessibilityRole="text"/m,
    '$1'
  );
  content = content.replace(
    '<View style={[styles.msgRow, styles.msgRowAssistant]} accessible accessibilityLabel={`AI：${response || content || activityText}`} accessibilityRole="text">',
    '<View style={[styles.msgRow, styles.msgRowAssistant]}>'
  );
  write(path, content);
}

function patchSettings() {
  const path = 'app/(tabs)/settings.tsx';
  let content = read(path);
  if (content.includes('BUILD22_SETTINGS_READY')) return;

  content = replaceOnce(content, '  ScrollView,\n', '  ScrollView,\n  Switch,\n', 'Switch import');
  content = replaceOnce(
    content,
    '    (key: keyof InferenceParams, value: number) => {\n      setInferenceParams({ [key]: value });\n    },',
    '    <K extends keyof InferenceParams,>(key: K, value: InferenceParams[K]) => {\n      setInferenceParams({ [key]: value } as Partial<InferenceParams>);\n    },',
    'typed inference update'
  );

  const settingsMarker = '// ─── Settings Screen ──────────────────────────────────────────────────────────';
  const toggleComponent = `const BUILD22_SETTINGS_READY = true;

function ToggleRow({
  label,
  description,
  value,
  onChange,
  colors,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.paramRow, { borderBottomColor: colors.border }]}>
      <View style={styles.paramInfo}>
        <Text style={[styles.paramLabel, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.paramDesc, { color: colors.muted }]}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessible
        accessibilityRole="switch"
        accessibilityLabel={\`\${label}，当前\${value ? '开启' : '关闭'}\`}
        accessibilityState={{ checked: value }}
      />
    </View>
  );
}

`;
  content = replaceOnce(content, settingsMarker, toggleComponent + settingsMarker, 'toggle row component');

  const batchBlock = `          <ParamRow
            label="批处理大小 (n_batch)"
            description="每次处理的 token 批次大小，影响推理速度"
            value={params.n_batch}
            min={1}
            max={2048}
            step={64}
            onChange={(v) => update('n_batch', v)}
            colors={colors}
          />`;
  const memoryControls = `${batchBlock}

          <ParamRow
            label="微批处理大小 (n_ubatch)"
            description="控制单次计算临时缓冲；大模型建议 16 到 64"
            value={params.n_ubatch}
            min={1}
            max={512}
            step={16}
            onChange={(v) => update('n_ubatch', v)}
            colors={colors}
          />

          <ToggleRow
            label="内存映射 (mmap)"
            description="直接映射 GGUF 文件并按需分页。大模型通常建议开启"
            value={params.use_mmap}
            onChange={(v) => update('use_mmap', v)}
            colors={colors}
          />

          <ToggleRow
            label="内存锁定 (mlock)"
            description="阻止模型页被系统回收；17GB 等大模型通常应关闭，否则更容易内存不足"
            value={params.use_mlock}
            onChange={(v) => update('use_mlock', v)}
            colors={colors}
          />

          <ToggleRow
            label="大模型安全模式"
            description="模型文件超过 12GB 时自动限制上下文、批次、GPU 层，并压缩 KV 缓存"
            value={params.large_model_safe_mode}
            onChange={(v) => update('large_model_safe_mode', v)}
            colors={colors}
          />`;
  content = replaceOnce(content, batchBlock, memoryControls, 'memory controls');
  content = content.replace(
    '• 增大 n_ctx 会显著增加内存占用{\'\\n\'}',
    '• 增大 n_ctx 会显著增加内存占用{\'\\n\'}\n            • 12GB 以上模型建议开启 mmap、关闭 mlock 和 GPU 层{\'\\n\'}\n            • 大模型闪退时优先把 n_batch 调到 64、n_ubatch 调到 32{\'\\n\'}'
  );
  write(path, content);
}

patchTypes();
patchModelService();
patchToolsService();
patchChat();
patchSettings();
console.log('[build22] all patches applied');
