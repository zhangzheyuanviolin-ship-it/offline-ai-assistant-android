import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content, 'utf8'); console.log(`[build40] patched ${path}`); }
function replaceOnce(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`[build40] target not found: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}
function replaceRange(content, start, end, replacement, label) {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) throw new Error(`[build40] range start not found: ${label}`);
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`[build40] range end not found: ${label}`);
  return content.slice(0, startIndex) + replacement + content.slice(endIndex + end.length);
}

function patchTypes() {
  const path = 'lib/types.ts';
  let content = read(path);
  if (content.includes('BUILD40_MEMORY_CONTROLS')) return;
  content = replaceOnce(
    content,
    '  n_batch: number;\n  n_threads: number;\n  n_gpu_layers: number;\n',
    '  n_batch: number;\n  n_ubatch: number;\n  n_threads: number;\n  n_gpu_layers: number;\n  use_mmap: boolean;\n  use_mlock: boolean;\n  large_model_safe_mode: boolean;\n',
    'memory fields'
  );
  content = replaceOnce(
    content,
    '  n_batch: 256,\n  n_threads: 4,\n  n_gpu_layers: 0,\n',
    '  n_batch: 256,\n  n_ubatch: 64,\n  n_threads: 4,\n  n_gpu_layers: 0,\n  use_mmap: true,\n  use_mlock: false,\n  large_model_safe_mode: true,\n',
    'memory defaults'
  );
  content = content.replace('/**\n * 核心类型定义', '/**\n * BUILD40_MEMORY_CONTROLS\n * 核心类型定义');
  write(path, content);
}

function patchModelService() {
  const path = 'lib/services/model-service.ts';
  let content = read(path);
  if (content.includes('BUILD40_LARGE_MODEL_SAFE_PROFILE')) return;

  const diagnosticsStart = '      if (callback) {\n        const summary =';
  const diagnosticsEnd = '\n\n      return result;';
  const ds = content.indexOf(diagnosticsStart);
  if (ds >= 0) {
    const de = content.indexOf(diagnosticsEnd, ds);
    if (de < 0) throw new Error('[build40] diagnostics end not found');
    content = content.slice(0, ds)
      + '      // BUILD40: diagnostics remain out-of-band and never enter visible/model text.\n'
      + content.slice(de);
  }

  const initStart = '  const context = await initLlama(\n    {\n      model: model.filePath,';
  const initEnd = '    (progress) => {';
  const initReplacement = `  // BUILD40_LARGE_MODEL_SAFE_PROFILE
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
  if (content.includes('BUILD40_SEARCH_RESULTS_READY')) return;

  const ddgStart = 'async function searchDuckDuckGo(';
  const ddgEnd = '/**\n * 百度搜索 HTML 抓取';
  const ddgReplacement = `const BUILD40_SEARCH_RESULTS_READY = true;

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

function parseDuckDuckGoHtml(html: string, maxResults: number): Array<{ title: string; url: string; content: string }> {
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
    'search result count'
  );

  const formatStart = '    // 统一格式化结果（极简，节省 token）';
  const formatEnd = '    if (results.length === 0) {';
  const formatReplacement = `    const results = rawResults
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
        r.snippet ? \`摘要：\${r.snippet}\` : '摘要：搜索页未提供摘要。',
        \`链接：\${r.url}\`,
      ].join('\\n')),
    ].join('\\n\\n');

`;
  content = replaceRange(content, formatStart, formatEnd, formatReplacement + formatEnd, 'search formatting');
  content = replaceOnce(
    content,
    '      data: { query, engine, count: results.length, results },',
    '      data: { query, engine, count: results.length, results, text },',
    'search text field'
  );
  write(path, content);
}

function patchChatSafety() {
  const path = 'app/(tabs)/index.tsx';
  let content = read(path);
  if (content.includes('BUILD40_ACCESSIBILITY_SAFE_STREAMING')) return;

  content = replaceOnce(
    content,
    "import { ChatMessage, ToolCall, ToolLog } from '@/lib/types';",
    "import { ChatMessage, ToolCall, ToolLog, ToolResult } from '@/lib/types';",
    'ToolResult import'
  );

  content = replaceOnce(
    content,
    '  const nativeTools = buildNativeTools(toolsConfig);\n',
    `  const configuredNativeTools = buildNativeTools(toolsConfig);
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
    'intent-scoped tools'
  );

  content = replaceOnce(
    content,
    "        tools: nativeTools,\n        tool_choice: nativeTools.length > 0 ? 'auto' : undefined,\n",
    "        tools: toolCallRound === 0 ? nativeTools : [],\n        tool_choice: toolCallRound === 0 && nativeTools.length > 0 ? 'auto' : undefined,\n",
    'single tool round'
  );

  content = content.replace(
    /if \(tokenCount % 10 === 0 \|\| tokenCount === 1\) \{\n\s+onActivity\('streaming', `[^`]*`\);\n\s+\}/,
    "if (tokenCount === 1) onActivity('streaming', 'AI 正在生成回复...');"
  );

  const chatMarker = '// ─── Chat Screen ─────────────────────────────────────────────────────────────';
  const helper = `const BUILD40_ACCESSIBILITY_SAFE_STREAMING = true;

function formatToolResultForModel(result: ToolResult): string {
  if (!result.success) return \`错误：\${result.error ?? '工具执行失败'}\`;
  const data = result.data as { text?: unknown } | undefined;
  if (data && typeof data.text === 'string' && data.text.trim()) return data.text;
  try { return JSON.stringify(result.data ?? {}); } catch { return String(result.data ?? ''); }
}

`;
  content = replaceOnce(content, chatMarker, helper + chatMarker, 'tool result helper');
  content = content.replace(
    /resolve\(result\.success \? JSON\.stringify\(result\.data\) : `错误: \$\{result\.error\}`\);/g,
    'resolve(formatToolResultForModel(result));'
  );

  content = content.replace(/\n\s*n\s+onPress=/g, '\n              onPress=');
  content = content.replace(
    'onPress={() => setShowThinking(!showThinking)}',
    'onPress={() => setShowThinking((value) => !value)}'
  );

  content = content.replace(
    /<View\n\s+style=\{\[styles\.msgRow, isUser \? styles\.msgRowUser : styles\.msgRowAssistant\]\}\n\s+accessible\n\s+accessibilityLabel=\{[^\n]+\}\n\s+accessibilityRole="text"\n\s*>/m,
    '<View\n      style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]}\n    >'
  );
  content = content.replace(
    '<View style={[styles.msgRow, styles.msgRowAssistant]} accessible accessibilityLabel={`AI：${response || content || activityText}`} accessibilityRole="text">',
    '<View style={[styles.msgRow, styles.msgRowAssistant]}>'
  );

  content = content.replace(
    '{response || item.content}',
    "{isUser ? item.content : (response || (thinking ? '模型完成了思考，但没有生成最终回答。可展开思考过程查看。' : item.content))}"
  );
  content = content.replace(
    "{response || ''}\n            {'▌'}",
    "{response || (thinking ? 'AI 正在思考...' : '')}\n            {'▌'}"
  );

  content = content.replace(
    'style={styles.thinkingToggle}\n            >',
    'accessibilityState={{ expanded: showThinking }}\n              importantForAccessibility="yes"\n              style={styles.thinkingToggle}\n            >'
  );

  write(path, content);
}

function patchSettings() {
  const path = 'app/(tabs)/settings.tsx';
  let content = read(path);
  if (content.includes('BUILD40_SETTINGS_READY')) return;
  content = replaceOnce(content, '  ScrollView,\n', '  ScrollView,\n  Switch,\n', 'Switch import');
  content = replaceOnce(
    content,
    '    (key: keyof InferenceParams, value: number) => {\n      setInferenceParams({ [key]: value });\n    },',
    '    <K extends keyof InferenceParams,>(key: K, value: InferenceParams[K]) => {\n      setInferenceParams({ [key]: value } as Partial<InferenceParams>);\n    },',
    'typed update'
  );
  const marker = '// ─── Settings Screen ──────────────────────────────────────────────────────────';
  const toggle = `const BUILD40_SETTINGS_READY = true;

function ToggleRow({ label, description, value, onChange, colors }: {
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
  content = replaceOnce(content, marker, toggle + marker, 'toggle component');
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
  const controls = `${batchBlock}

          <ParamRow
            label="微批处理大小 (n_ubatch)"
            description="控制临时计算缓冲；大模型建议 16 到 64"
            value={params.n_ubatch}
            min={1}
            max={512}
            step={16}
            onChange={(v) => update('n_ubatch', v)}
            colors={colors}
          />

          <ToggleRow
            label="内存映射 (mmap)"
            description="按需映射 GGUF 文件；大模型通常建议开启"
            value={params.use_mmap}
            onChange={(v) => update('use_mmap', v)}
            colors={colors}
          />

          <ToggleRow
            label="内存锁定 (mlock)"
            description="阻止模型页被系统回收；大模型通常应关闭"
            value={params.use_mlock}
            onChange={(v) => update('use_mlock', v)}
            colors={colors}
          />

          <ToggleRow
            label="大模型安全模式"
            description="12GB 以上模型自动降低上下文、批次与缓存占用"
            value={params.large_model_safe_mode}
            onChange={(v) => update('large_model_safe_mode', v)}
            colors={colors}
          />`;
  content = replaceOnce(content, batchBlock, controls, 'memory controls');
  write(path, content);
}

patchTypes();
patchModelService();
patchToolsService();
patchChatSafety();
patchSettings();
console.log('[build40] emergency safety patches applied');
