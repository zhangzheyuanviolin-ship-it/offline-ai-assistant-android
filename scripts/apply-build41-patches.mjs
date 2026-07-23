import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, content) { fs.writeFileSync(path, content, 'utf8'); console.log(`[build41] patched ${path}`); }
function replaceOnce(content, search, replacement, label) {
  if (content.includes(replacement)) return content;
  const index = content.indexOf(search);
  if (index < 0) throw new Error(`[build41] target not found: ${label}`);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}
function replaceRange(content, start, end, replacement, label) {
  const startIndex = content.indexOf(start);
  if (startIndex < 0) throw new Error(`[build41] range start not found: ${label}`);
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`[build41] range end not found: ${label}`);
  return content.slice(0, startIndex) + replacement + content.slice(endIndex);
}

function patchTypes() {
  const path = 'lib/types.ts';
  let content = read(path);
  if (content.includes('BUILD41_MODEL_STORAGE_AND_REASONING')) return;

  content = replaceOnce(
    content,
    "  isLoaded: boolean;\n}",
    "  isLoaded: boolean;\n  storageMode: 'copied' | 'external';\n  sourceUri?: string;\n}",
    'model storage fields'
  );
  content = replaceOnce(
    content,
    '  n_batch: number;\n  n_threads: number;\n  n_gpu_layers: number;\n',
    '  n_batch: number;\n  n_ubatch: number;\n  n_threads: number;\n  n_gpu_layers: number;\n  use_mmap: boolean;\n  use_mlock: boolean;\n',
    'memory fields'
  );
  content = replaceOnce(
    content,
    '  n_batch: 256,\n  n_threads: 4,\n  n_gpu_layers: 0,\n',
    '  n_batch: 256,\n  n_ubatch: 64,\n  n_threads: 4,\n  n_gpu_layers: 0,\n  use_mmap: true,\n  use_mlock: false,\n',
    'memory defaults'
  );
  content = replaceOnce(
    content,
    '  content: string;\n  timestamp: number;\n',
    '  content: string;\n  reasoning?: string;\n  timestamp: number;\n',
    'reasoning field'
  );
  content = content.replace('/**\n * 核心类型定义', '/**\n * BUILD41_MODEL_STORAGE_AND_REASONING\n * 核心类型定义');
  write(path, content);
}

function patchToolsService() {
  const path = 'lib/services/tools-service.ts';
  let content = read(path);
  if (content.includes('BUILD41_TOOL_ADAPTERS')) return;

  const nativeStart = 'export function buildNativeTools(toolsConfig: ToolsConfig): Array<Record<string, unknown>> {';
  const nativeEnd = '\n\n// ─── Tool Helpers';
  const nativeReplacement = `export function buildNativeTools(toolsConfig: ToolsConfig): Array<Record<string, unknown>> {
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
}`;
  content = replaceRange(content, nativeStart, nativeEnd, nativeReplacement + nativeEnd, 'minimal native schemas');

  const ddgStart = 'async function searchDuckDuckGo(';
  const ddgEnd = '/**\n * 百度搜索 HTML 抓取';
  const ddgReplacement = `const BUILD41_TOOL_ADAPTERS = true;

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
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\\s+/g, ' ')
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
  const anchor = /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null && results.length < maxResults) {
    const url = decodeDuckDuckGoLink(match[1]);
    const title = decodeHtmlText(match[2]);
    if (!/^https?:\\/\\//i.test(url) || title.length < 3 || seen.has(url)) continue;
    const nearby = html.slice(match.index, Math.min(html.length, match.index + 2400));
    const snippetMatch = nearby.match(/<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:a|div)>/i);
    const snippet = snippetMatch ? decodeHtmlText(snippetMatch[1]) : '';
    if (/\\$\\{|\\{\\{|template|placeholder/i.test(title + ' ' + snippet)) continue;
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
      body: \`q=\${encodeURIComponent(query)}\`,
    }),
    () => fetch(\`https://lite.duckduckgo.com/lite/?q=\${encodeURIComponent(query)}\`, {
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
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
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
  throw new Error(\`DuckDuckGo 搜索失败：\${lastError}\`);
}

`;
  content = replaceRange(content, ddgStart, ddgEnd, ddgReplacement + ddgEnd, 'DuckDuckGo adapter');

  const execStart = 'async function execWebSearchTool(';
  const execEnd = '// ─── Main Executor';
  const execReplacement = `async function execWebSearchTool(
  name: string,
  p: Record<string, unknown>,
  toolsConfig: ToolsConfig
): Promise<ToolResult> {
  const ts = Date.now();
  if (name !== 'search') return { toolName: name, success: false, error: \`未知搜索工具: \${name}\`, timestamp: ts };

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
      .filter((item) => item.title.length >= 3 && /^https?:\\/\\//i.test(item.url))
      .filter((item) => !htmlEngine || !/\\$\\{|\\{\\{|template|placeholder/i.test(item.title + ' ' + item.snippet));

    if (results.length === 0) {
      return { toolName: name, success: false, error: \`\${engine} 没有返回可用结果\`, timestamp: ts };
    }

    const text = [
      \`搜索关键词：\${query}\`,
      \`搜索引擎：\${engine}，结果：\${results.length} 条\`,
      ...results.map((item) => [
        \`\${item.i}. \${item.title}\`,
        item.snippet ? \`摘要：\${item.snippet}\` : '摘要：该搜索源未提供摘要。',
        \`链接：\${item.url}\`,
      ].join('\\n')),
    ].join('\\n\\n');

    return {
      toolName: name,
      success: true,
      data: { query, engine, count: results.length, results, text },
      timestamp: ts,
    };
  } catch (error) {
    return { toolName: name, success: false, error: \`搜索失败(\${engine}): \${String(error)}\`, timestamp: ts };
  }
}

export function formatToolResultForModel(result: ToolResult): string {
  if (!result.success) return \`错误：\${result.error ?? '工具执行失败'}\`;
  const data = result.data as { text?: unknown } | undefined;
  if (data && typeof data.text === 'string' && data.text.trim()) return data.text;
  try { return JSON.stringify(result.data ?? {}); } catch { return String(result.data ?? ''); }
}

`;
  content = replaceRange(content, execStart, execEnd, execReplacement + execEnd, 'isolated search adapters');
  write(path, content);
}

function patchModelService() {
  const path = 'lib/services/model-service.ts';
  let content = read(path);
  if (content.includes('BUILD41_EXTERNAL_MODEL_REFERENCE')) return;

  content = replaceOnce(
    content,
    "import { AIModel, InferenceParams } from '../types';",
    "import { AIModel, InferenceParams } from '../types';\nimport { closeAllExternalModelUris, closeExternalModelUri, openExternalModelUri } from './external-model-file';",
    'external model imports'
  );
  content = replaceOnce(
    content,
    'const CONFLICTING_TOOL_STOPS = new Set([\'{"t":\', \'```json\']);',
    'const CONFLICTING_TOOL_STOPS = new Set([\'{"t":\', \'```json\']);\nconst BUILD41_EXTERNAL_MODEL_REFERENCE = true;\nexport type ModelImportMode = \'external\' | \'copy\';',
    'model marker'
  );

  const importStart = '/** 从文件选择器导入 GGUF 模型 */';
  const importEnd = '/** 删除模型文件 */';
  const importReplacement = `/** 从文件选择器导入或直接引用 GGUF 模型 */
export async function pickAndImportModel(mode: ModelImportMode = 'external'): Promise<AIModel | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: mode === 'copy',
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]) return null;

  const asset = result.assets[0];
  const fileName = asset.name;
  const sourceUri = asset.uri;
  if (!/\\.gguf$/i.test(fileName)) throw new Error('请选择 GGUF 格式的模型文件');

  const modelId = \`model_\${Date.now()}\`;
  if (mode === 'external') {
    let fileSize = asset.size ?? 0;
    if (fileSize <= 0 && sourceUri.startsWith('file://')) {
      const info = await FileSystem.getInfoAsync(sourceUri);
      fileSize = (info as { size?: number }).size ?? 0;
    }
    return {
      id: modelId,
      name: fileName.replace(/\\.gguf$/i, ''),
      filePath: sourceUri,
      sourceUri,
      storageMode: 'external',
      fileSize,
      fileSizeLabel: fileSize > 0 ? formatFileSize(fileSize) : '大小将在加载时确认',
      format: 'gguf',
      addedAt: Date.now(),
      isLoaded: false,
    };
  }

  await ensureModelsDir();
  const destPath = \`\${MODELS_DIR}\${modelId}_\${fileName}\`;
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: destPath });
  } catch (error) {
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
    throw error;
  }
  const info = await FileSystem.getInfoAsync(destPath);
  const fileSize = (info as { size?: number }).size ?? 0;
  if (!info.exists || fileSize <= 0) {
    await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
    throw new Error('模型复制失败：目标文件不存在或大小为 0');
  }
  return {
    id: modelId,
    name: fileName.replace(/\\.gguf$/i, ''),
    filePath: destPath,
    storageMode: 'copied',
    fileSize,
    fileSizeLabel: formatFileSize(fileSize),
    format: 'gguf',
    addedAt: Date.now(),
    isLoaded: false,
  };
}

`;
  content = replaceRange(content, importStart, importEnd, importReplacement + importEnd, 'model import modes');

  content = replaceOnce(
    content,
    "  await FileSystem.deleteAsync(model.filePath, { idempotent: true });",
    "  if (model.storageMode === 'external') {\n    await closeExternalModelUri(model.sourceUri ?? model.filePath);\n    return;\n  }\n  await FileSystem.deleteAsync(model.filePath, { idempotent: true });",
    'external metadata deletion'
  );
  content = replaceOnce(
    content,
    'let _completionInFlight = 0;\nlet _lastDiagnostics: InferenceDiagnostics | null = null;',
    'let _completionInFlight = 0;\nlet _lastDiagnostics: InferenceDiagnostics | null = null;\nlet _activeExternalUri: string | null = null;',
    'external runtime state'
  );

  const loadStart = '/** 加载模型到内存（llama.rn initLlama） */';
  const loadEnd = '/** 释放当前模型 */';
  const loadReplacement = `/** 加载模型。外部模型通过持久化 SAF 文件描述符直接映射，不复制权重。 */
export async function loadModel(
  model: AIModel,
  params: InferenceParams,
  onProgress?: (progress: number) => void
): Promise<LlamaContext> {
  if (_completionInFlight > 0) throw new Error('模型正在生成内容，不能切换或重新加载模型');

  if (_activeContext) {
    await _activeContext.release();
    _activeContext = null;
  }
  if (_activeExternalUri) {
    await closeExternalModelUri(_activeExternalUri);
    _activeExternalUri = null;
  }
  _activeModelId = null;

  let resolvedPath = model.filePath;
  const externalUri = model.storageMode === 'external' ? (model.sourceUri ?? model.filePath) : null;
  if (externalUri) {
    const opened = await openExternalModelUri(externalUri);
    resolvedPath = opened.path.startsWith('/') ? \`file://\${opened.path}\` : opened.path;
  }

  try {
    const context = await initLlama(
      {
        model: resolvedPath,
        n_ctx: params.n_ctx,
        n_batch: params.n_batch,
        n_ubatch: Math.max(1, Math.min(params.n_ubatch, params.n_batch)),
        n_threads: params.n_threads,
        n_gpu_layers: params.n_gpu_layers,
        use_mlock: params.use_mlock,
        use_mmap: params.use_mmap,
        n_parallel: 1,
        kv_unified: true,
        no_extra_bufts: true,
      } as Parameters<typeof initLlama>[0],
      (progress) => onProgress?.(progress)
    );
    _activeContext = installCompletionGuard(context);
    _activeModelId = model.id;
    _activeExternalUri = externalUri;
    _lastDiagnostics = null;
    return _activeContext;
  } catch (error) {
    if (externalUri) await closeExternalModelUri(externalUri);
    _activeExternalUri = null;
    _activeModelId = null;
    throw error;
  }
}

`;
  content = replaceRange(content, loadStart, loadEnd, loadReplacement + loadEnd, 'model loading');

  content = replaceOnce(
    content,
    '    _activeModelId = null;\n  }\n}',
    '    _activeModelId = null;\n  }\n  if (_activeExternalUri) {\n    await closeExternalModelUri(_activeExternalUri);\n    _activeExternalUri = null;\n  }\n}',
    'release external descriptor'
  );
  content = replaceOnce(
    content,
    '  await releaseAllLlama();\n  _activeContext = null;',
    '  await releaseAllLlama();\n  await closeAllExternalModelUris();\n  _activeContext = null;',
    'release all external descriptors'
  );
  content = replaceOnce(
    content,
    '  _activeModelId = null;\n  _lastDiagnostics = null;\n}',
    '  _activeModelId = null;\n  _activeExternalUri = null;\n  _lastDiagnostics = null;\n}',
    'clear external state'
  );
  write(path, content);
}

function patchStore() {
  const path = 'lib/store.ts';
  let content = read(path);
  if (content.includes('BUILD41_RUNTIME_STATE_AUTHORITY')) return;

  content = replaceOnce(
    content,
    'const serializable = models.map((model) => ({ ...model, isLoaded: false }));',
    "const serializable = models.map((model) => ({ ...model, isLoaded: false, storageMode: model.storageMode ?? (model.filePath.startsWith('content://') ? 'external' : 'copied') }));",
    'persist storage mode'
  );
  content = replaceOnce(
    content,
    '        const storedModels: AIModel[] = modelsJson ? JSON.parse(modelsJson) : [];',
    "        const storedModels: AIModel[] = modelsJson ? JSON.parse(modelsJson) : [];\n        const BUILD41_RUNTIME_STATE_AUTHORITY = true;",
    'store marker'
  );
  content = replaceOnce(
    content,
    '          models: storedModels.map((model) => ({ ...model, isLoaded: model.id === nativeModelId })),\n          activeModelId: nativeModelId ?? activeId ?? null,',
    "          models: storedModels.map((model) => ({\n            ...model,\n            storageMode: model.storageMode ?? (model.filePath.startsWith('content://') ? 'external' : 'copied'),\n            sourceUri: model.sourceUri ?? (model.filePath.startsWith('content://') ? model.filePath : undefined),\n            isLoaded: model.id === nativeModelId,\n          })),\n          activeModelId: nativeModelId,",
    'load authoritative state'
  );
  content = replaceOnce(
    content,
    '      activeModelId: nativeModelId ?? state.activeModelId,',
    '      activeModelId: nativeModelId,',
    'sync authoritative state'
  );
  content = replaceOnce(
    content,
    'export const selectActiveModel = (state: AppStore) =>\n  state.models.find((model) => model.id === state.activeModelId) ?? null;',
    'export const selectActiveModel = (state: AppStore) =>\n  state.models.find((model) => model.id === state.activeModelId && model.isLoaded) ?? null;',
    'active model selector'
  );
  write(path, content);
}

function patchModelsScreen() {
  const path = 'app/(tabs)/models.tsx';
  let content = read(path);
  if (content.includes('BUILD41_IMPORT_CHOICES')) return;

  content = replaceOnce(
    content,
    '  releaseModel,\n} from \'@/lib/services/model-service\';',
    '  releaseModel,\n  ModelImportMode,\n} from \'@/lib/services/model-service\';',
    'import mode type'
  );
  content = replaceOnce(
    content,
    '    loadModelsFromStorage,\n  } = useAppStore();',
    '    loadModelsFromStorage,\n    syncModelLoadedState,\n  } = useAppStore();',
    'sync action'
  );

  const importStart = '  const handleImport = useCallback(async () => {';
  const importEnd = '\n\n  const handleLoad = useCallback(';
  const importReplacement = `  const performImport = useCallback(async (mode: ModelImportMode) => {
    setIsImporting(true);
    try {
      const model = await pickAndImportModel(mode);
      if (!model) return;
      addModel(model);
      Alert.alert(
        '导入成功',
        mode === 'external'
          ? \`已直接引用模型“\${model.name}”。模型权重不会复制到应用目录，加载时通过外部文件描述符按需映射。\n大小：\${model.fileSizeLabel}\`
          : \`模型“\${model.name}”已复制到应用目录。\n大小：\${model.fileSizeLabel}\`
      );
    } catch (err) {
      Alert.alert('导入失败', err instanceof Error ? err.message : '未知错误');
    } finally {
      setIsImporting(false);
    }
  }, [addModel]);

  const BUILD41_IMPORT_CHOICES = true;
  const handleImport = useCallback(() => {
    Alert.alert(
      '选择导入方式',
      '直接引用不会复制模型，推荐用于十几 GB 的大模型；复制导入兼容不支持随机读取的文件提供方。',
      [
        { text: '直接引用（推荐大模型）', onPress: () => performImport('external') },
        { text: '复制到应用', onPress: () => performImport('copy') },
        { text: '取消', style: 'cancel' },
      ]
    );
  }, [performImport]);`;
  content = replaceRange(content, importStart, importEnd, importReplacement + importEnd, 'import mode UI');

  content = content.replace(
    '        setActiveModel(model.id);\n        Alert.alert(\'加载成功\'',
    '        setActiveModel(model.id);\n        syncModelLoadedState();\n        Alert.alert(\'加载成功\''
  );
  content = content.replace(
    "      } catch (err) {\n        Alert.alert('加载失败'",
    "      } catch (err) {\n        syncModelLoadedState();\n        Alert.alert('加载失败'"
  );
  content = content.replace(
    '[loadingModelId, inferenceParams, setModelLoaded, setActiveModel]',
    '[loadingModelId, inferenceParams, setModelLoaded, setActiveModel, syncModelLoadedState]'
  );
  content = content.replace(
    '      const isActive = item.id === activeModelId;',
    '      const isActive = item.id === activeModelId && item.isLoaded;'
  );
  content = content.replace(
    "{item.fileSizeLabel} · GGUF · {isActive ? '✅ 已加载' : '⏳ 未加载'}",
    "{item.fileSizeLabel} · GGUF · {item.storageMode === 'external' ? '外部直接引用' : '应用内副本'} · {isActive ? '✅ 已加载' : '⏳ 未加载'}"
  );
  content = content.replace(
    '`确定要删除 "${model.name}" 吗？\\n此操作不可撤销。`',
    'model.storageMode === \'external\'\n          ? `确定从列表移除“${model.name}”吗？外部原文件不会被删除。`\n          : `确定要删除“${model.name}”吗？\\n应用内模型副本将被永久删除。`'
  );
  write(path, content);
}

function patchSettings() {
  const path = 'app/(tabs)/settings.tsx';
  let content = read(path);
  if (content.includes('BUILD41_MEMORY_SETTINGS')) return;

  content = replaceOnce(content, '  ScrollView,\n', '  ScrollView,\n  Switch,\n', 'Switch import');
  content = replaceOnce(
    content,
    '    (key: keyof InferenceParams, value: number) => {\n      setInferenceParams({ [key]: value });\n    },',
    '    <K extends keyof InferenceParams,>(key: K, value: InferenceParams[K]) => {\n      setInferenceParams({ [key]: value } as Partial<InferenceParams>);\n    },',
    'typed update'
  );

  const screenMarker = '// ─── Settings Screen';
  const toggleComponent = `const BUILD41_MEMORY_SETTINGS = true;

function ToggleRow({ label, description, value, onChange, colors }: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.paramRow, { borderBottomColor: colors.border }]} accessible={false}>
      <View style={styles.paramInfo} accessible={false}>
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
  content = replaceOnce(content, screenMarker, toggleComponent + screenMarker, 'toggle component');

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
            description="控制单次计算临时缓冲；大模型可尝试 16、32 或 64"
            value={params.n_ubatch}
            min={1}
            max={512}
            step={16}
            onChange={(v) => update('n_ubatch', v)}
            colors={colors}
          />

          <ToggleRow
            label="内存映射 (mmap)"
            description="按需映射 GGUF 文件页面，通常建议开启，尤其是外部大模型"
            value={params.use_mmap}
            onChange={(v) => update('use_mmap', v)}
            colors={colors}
          />

          <ToggleRow
            label="内存锁定 (mlock)"
            description="阻止模型页面被系统回收；十几 GB 模型通常应关闭"
            value={params.use_mlock}
            onChange={(v) => update('use_mlock', v)}
            colors={colors}
          />`;
  content = replaceOnce(content, batchBlock, controls, 'memory controls');

  content = replaceOnce(
    content,
    '  const handleUnloadModel = async () => {',
    `  const applyMoEPreset = () => {
    Alert.alert('应用 30B MoE 低内存预设', '将上下文设为 2048、batch 64、ubatch 32、纯 CPU、开启 mmap、关闭 mlock。参数仍可继续手动修改。', [
      { text: '取消', style: 'cancel' },
      {
        text: '应用',
        onPress: () => setInferenceParams({
          n_ctx: 2048,
          n_batch: 64,
          n_ubatch: 32,
          n_gpu_layers: 0,
          use_mmap: true,
          use_mlock: false,
        }),
      },
    ]);
  };

  const handleUnloadModel = async () => {`,
    'MoE preset handler'
  );
  content = replaceOnce(
    content,
    '        {/* 硬件加速 */}',
    `        <TouchableOpacity
          style={[styles.presetBtn, { borderColor: colors.primary }]}
          onPress={applyMoEPreset}
          accessible
          accessibilityRole="button"
          accessibilityLabel="应用 30B MoE 低内存预设"
          accessibilityHint="双击设置上下文 2048、batch 64、ubatch 32、纯 CPU、开启内存映射并关闭内存锁定"
        >
          <Text style={[styles.presetBtnText, { color: colors.primary }]}>应用 30B MoE 低内存预设</Text>
        </TouchableOpacity>

        {/* 硬件加速 */}`,
    'preset button'
  );
  content = replaceOnce(
    content,
    '  resetBtn: {',
    "  presetBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },\n  presetBtnText: { fontSize: 15, fontWeight: '600' },\n  resetBtn: {",
    'preset styles'
  );
  write(path, content);
}

function patchIndex() {
  const path = 'app/(tabs)/index.tsx';
  let content = read(path);
  if (content.includes('BUILD41_ACCESSIBILITY_BOUNDARY')) return;

  content = replaceOnce(
    content,
    "import { getActiveContext } from '@/lib/services/model-service';\n",
    "import { runInferenceOrchestrator } from '@/lib/services/inference-orchestrator';\nimport { AccessibilityChunkedText } from '@/components/accessibility-chunked-text';\n",
    'orchestrator imports'
  );
  const toolsImportStart = "import {\n  buildCompactSystemPrompt,";
  const toolsImportEnd = "} from '@/lib/services/tools-service';";
  content = replaceRange(
    content,
    toolsImportStart,
    toolsImportEnd,
    "import { executeTool, formatToolResultForModel, toolRequiresConfirmation } from '@/lib/services/tools-service';",
    'tools imports'
  );

  const inferenceStart = '// ─── Inference Engine';
  const inferenceEnd = '// ─── Parse thinking tags';
  content = replaceRange(content, inferenceStart, inferenceEnd, inferenceEnd, 'remove local inference loop');

  const parserStart = 'interface ParsedContent {';
  const parserEnd = '// ─── Activity Message';
  const parserReplacement = `const BUILD41_ACCESSIBILITY_BOUNDARY = true;

interface ParsedContent { thinking: string; response: string; }
function parseThinkingTags(text: string): ParsedContent {
  const normalized = text.replace(/<\\|[^|]+?\\|>/g, '').trim();
  const complete = normalized.match(/<(?:think|thinking)>([\\s\\S]*?)<\\/(?:think|thinking)>/i);
  if (complete) return { thinking: complete[1].trim(), response: normalized.replace(complete[0], '').trim() };
  const closing = normalized.match(/<\\/(?:think|thinking)>/i);
  if (closing && closing.index !== undefined) {
    return { thinking: normalized.slice(0, closing.index).trim(), response: normalized.slice(closing.index + closing[0].length).trim() };
  }
  return { thinking: '', response: normalized };
}

`;
  content = replaceRange(content, parserStart, parserEnd, parserReplacement + parserEnd, 'legacy thinking parser');

  const messageStart = '// ─── Message Item';
  const messageEnd = '// ─── Chat Screen';
  const messageReplacement = `// ─── Message Item ────────────────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({ item, colors }: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const isUser = item.role === 'user';
  const legacy = isUser ? { thinking: '', response: item.content } : parseThinkingTags(item.content);
  const thinking = isUser ? '' : (item.reasoning?.trim() || legacy.thinking);
  const response = isUser ? item.content : (legacy.response || (thinking ? '模型没有生成最终回答。' : item.content));
  const [showThinking, setShowThinking] = useState(false);

  return (
    <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]} accessible={false}>
      <View
        style={[styles.msgBubble, {
          backgroundColor: isUser ? colors.primary : colors.surface,
          borderColor: isUser ? colors.primary : colors.border,
        }]}
        accessible={false}
      >
        {!isUser && thinking.length > 0 && (
          <View style={styles.thinkingContainer} accessible={false}>
            <TouchableOpacity
              onPress={() => setShowThinking((value) => !value)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={\`\${showThinking ? '隐藏' : '展开'}思考过程\`}
              accessibilityState={{ expanded: showThinking }}
              importantForAccessibility="yes"
              style={styles.thinkingToggle}
            >
              <Text style={[styles.thinkingToggleText, { color: colors.muted }]}>
                {showThinking ? '▼ 思考过程' : '▶ 思考过程'}
              </Text>
            </TouchableOpacity>
            {showThinking && (
              <View style={[styles.thinkingContent, { borderColor: colors.border }]} accessible={false}>
                <AccessibilityChunkedText
                  text={thinking}
                  label="思考过程"
                  style={[styles.thinkingText, { color: colors.muted }]}
                />
              </View>
            )}
          </View>
        )}
        <AccessibilityChunkedText
          text={response}
          label={isUser ? '您' : '最终回答'}
          style={[styles.msgText, { color: isUser ? '#fff' : colors.foreground }]}
        />
      </View>
      <Text style={[styles.msgTime, { color: colors.muted }]} accessible={false}>
        {new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );
});

const StreamingMessage = memo(function StreamingMessage({ activityText, colors }: {
  activityText: string;
  colors: ReturnType<typeof useColors>;
}) {
  const status = activityText || 'AI 正在处理...';
  return (
    <View style={[styles.msgRow, styles.msgRowAssistant]} accessible={false}>
      <View style={[styles.msgBubble, { backgroundColor: colors.surface, borderColor: colors.border }]} accessible={false}>
        <View style={styles.typingIndicator} accessible={false}>
          <ActivityIndicator size="small" color={colors.muted} />
          <Text
            style={[styles.typingText, { color: colors.muted }]}
            accessible
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            accessibilityLabel={status}
          >
            {status}
          </Text>
        </View>
      </View>
    </View>
  );
});

`;
  content = replaceRange(content, messageStart, messageEnd, messageReplacement + messageEnd, 'safe message components');

  content = content.replace("  const [streamContent, setStreamContent] = useState('');\n", '');
  const pusherStart = '  // 创建 token 推送器';
  const pusherEnd = '  // 发送消息';
  content = replaceRange(content, pusherStart, pusherEnd, pusherEnd, 'remove cumulative stream buffer');

  content = content.replace("    setStreamContent('');\n", '');
  content = content.replace('    const pusher = createPushToken();\n', '');
  content = content.replace(
    '      const finalText = await runInference(\n        text,\n        currentMessages,\n        currentTools,\n        currentParams,\n        ws,\n        (token) => pusher.push(token),\n        handleToolCall,',
    '      const finalResult = await runInferenceOrchestrator(\n        text,\n        currentMessages,\n        currentTools,\n        currentParams,\n        handleToolCall,'
  );
  content = content.replace(/\n\s*\/\/ flush 残余 token\n\s*pusher\.flush\(\);\n/, '\n');
  content = content.replace("      setStreamContent('');\n", '');
  content = content.replace('        content: finalText,', '        content: finalResult.content,\n        reasoning: finalResult.reasoning || undefined,');
  content = content.replace('      pusher.cancel();\n', '');
  content = content.replace('    createPushToken,\n', '');
  content = content.replace(
    "? [...messages, { id: '__streaming__', isStreaming: true, content: streamContent, role: 'assistant', timestamp: Date.now(), _activity: streamActivity } as unknown as ChatMessage]",
    "? [...messages, { id: '__streaming__', isStreaming: true, content: '', role: 'assistant', timestamp: Date.now(), _activity: streamActivity } as unknown as ChatMessage]"
  );
  content = content.replace(
    '<StreamingMessage content={streamContent} activityText={streamActivity} colors={colors} />',
    '<StreamingMessage activityText={streamActivity} colors={colors} />'
  );
  content = content.replace('  }, [colors, streamContent, streamActivity]);', '  }, [colors, streamActivity]);');
  content = content.replace(
    /resolve\(result\.success \? JSON\.stringify\(result\.data\) : `错误: \$\{result\.error\}`\);/g,
    'resolve(formatToolResultForModel(result));'
  );
  write(path, content);
}

function validate() {
  const index = read('app/(tabs)/index.tsx');
  const orchestrator = read('lib/services/inference-orchestrator.ts');
  const model = read('lib/services/model-service.ts');
  const store = read('lib/store.ts');
  const tools = read('lib/services/tools-service.ts');
  const settings = read('app/(tabs)/settings.tsx');
  const models = read('app/(tabs)/models.tsx');
  const failures = [];
  const check = (ok, label) => { if (!ok) failures.push(label); };

  check(index.includes('runInferenceOrchestrator'), 'orchestrator import');
  check(!index.includes('本轮已生成'), 'no token-count activity');
  check(!index.includes('createPushToken'), 'no cumulative JS stream buffer');
  check(index.includes('AccessibilityChunkedText'), 'chunked accessibility output');
  check(orchestrator.includes("role: 'tool'"), 'native tool result role');
  check(orchestrator.includes('tool_calls: nativeCalls'), 'assistant tool call history');
  check(!orchestrator.includes('MAX_TOOL_ROUNDS'), 'no fixed tool-round cap');
  check(orchestrator.includes("tools: nativeTools.length > 0 ? nativeTools : undefined"), 'all enabled tools each round');
  check(model.includes('openExternalModelUri'), 'external descriptor loading');
  check(model.includes("storageMode: 'external'"), 'external model metadata');
  check(store.includes('activeModelId: nativeModelId,'), 'runtime state authority');
  check(tools.includes('BUILD41_TOOL_ADAPTERS'), 'isolated search adapters');
  check(tools.includes('formatToolResultForModel'), 'tool result formatter');
  check(settings.includes('内存映射 (mmap)'), 'mmap setting');
  check(settings.includes('内存锁定 (mlock)'), 'mlock setting');
  check(models.includes('直接引用（推荐大模型）'), 'direct import UI');
  if (failures.length) throw new Error(`[build41] validation failed: ${failures.join(', ')}`);
  console.log('[build41] validation passed');
}

patchTypes();
patchToolsService();
patchModelService();
patchStore();
patchModelsScreen();
patchSettings();
patchIndex();
validate();
console.log('[build41] all sustainable patches applied');
