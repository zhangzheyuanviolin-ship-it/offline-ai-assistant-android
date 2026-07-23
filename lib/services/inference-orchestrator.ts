import { getActiveContext } from './model-service';
import { buildNativeTools, getToolCategory, parseToolCalls } from './tools-service';
import { ChatMessage, InferenceParams, ToolCall, ToolsConfig } from '../types';

export type InferenceActivityKind =
  | 'thinking'
  | 'streaming'
  | 'tool_calling'
  | 'tool_done'
  | 'warning'
  | 'error';

export type InferenceStreamPhase = 'thinking' | 'answering';

export interface InferenceStreamSnapshot {
  content: string;
  reasoning: string;
  phase: InferenceStreamPhase;
  toolSteps: number;
}

export interface InferenceResult {
  content: string;
  reasoning: string;
  toolSteps: number;
}

type NativeToolCall = {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: string;
  };
};

type NativeMessage = {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: NativeToolCall[];
  tool_call_id?: string;
};

type StreamParserState = {
  contentSnapshot: string;
  reasoningSnapshot: string;
  accumulatedSnapshot: string;
  tokenFallback: string;
};

const STREAM_INTERVAL_MS = 90;
const STREAM_CHARACTER_STEP = 12;

function stripControlTokens(text: string): string {
  return text.replace(/<\|[^|]+?\|>/g, '');
}

function stripToolControlForDisplay(text: string): string {
  const candidates = [
    text.search(/<tool_call>/i),
    text.search(/\{\s*"t"\s*:/i),
    text.search(/```json\s*\{\s*"t"\s*:/i),
  ].filter((index) => index >= 0);
  if (candidates.length === 0) return text;
  return text.slice(0, Math.min(...candidates));
}

function splitThinkingContent(
  content: string,
  nativeReasoning: string,
  trim: boolean
): { content: string; reasoning: string } {
  const finish = (value: string) => (trim ? value.trim() : value);
  const normalized = stripControlTokens(content);
  const reasoning = stripControlTokens(nativeReasoning);

  if (reasoning.length > 0) {
    return {
      content: finish(stripToolControlForDisplay(normalized)),
      reasoning: finish(reasoning),
    };
  }

  const complete = normalized.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
  if (complete && complete.index !== undefined) {
    const before = normalized.slice(0, complete.index);
    const after = normalized.slice(complete.index + complete[0].length);
    return {
      reasoning: finish(complete[1]),
      content: finish(stripToolControlForDisplay(before + after)),
    };
  }

  const opening = normalized.match(/<(?:think|thinking)>/i);
  if (opening && opening.index !== undefined) {
    return {
      content: finish(stripToolControlForDisplay(normalized.slice(0, opening.index))),
      reasoning: finish(normalized.slice(opening.index + opening[0].length)),
    };
  }

  // 部分模型只在思考结束时输出 </think>，llama.rn 通常会通过
  // reasoning_content 分离；这里保留兼容路径。
  const closing = normalized.match(/<\/(?:think|thinking)>/i);
  if (closing && closing.index !== undefined) {
    return {
      reasoning: finish(normalized.slice(0, closing.index)),
      content: finish(stripToolControlForDisplay(normalized.slice(closing.index + closing[0].length))),
    };
  }

  return { content: finish(stripToolControlForDisplay(normalized)), reasoning: '' };
}

function normalizeNativeToolCalls(raw: unknown): NativeToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: NativeToolCall[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const value = entry as {
      id?: string;
      name?: string;
      arguments?: unknown;
      function?: { name?: string; arguments?: unknown };
    };
    const name = value.function?.name ?? value.name ?? '';
    if (!name) return;
    const rawArguments = value.function?.arguments ?? value.arguments ?? {};
    let argumentsText: string;
    if (typeof rawArguments === 'string') {
      try {
        argumentsText = JSON.stringify(JSON.parse(rawArguments));
      } catch {
        argumentsText = '{}';
      }
    } else {
      try {
        argumentsText = JSON.stringify(rawArguments ?? {});
      } catch {
        argumentsText = '{}';
      }
    }
    calls.push({
      type: 'function',
      id: value.id || `tool_${Date.now()}_${index}`,
      function: { name, arguments: argumentsText },
    });
  });
  return calls;
}

function parseToolArguments(call: NativeToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(call.function.arguments);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function buildHistory(historySnapshot: ChatMessage[], userText: string): NativeMessage[] {
  const recent = historySnapshot
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-20)
    .map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.role === 'assistant' && message.reasoning
        ? { reasoning_content: message.reasoning }
        : {}),
    }));

  const last = recent[recent.length - 1];
  if (!(last?.role === 'user' && last.content === userText)) {
    recent.push({ role: 'user', content: userText });
  }
  return recent;
}

function joinParts(previous: string, current: string): string {
  if (!previous) return current;
  if (!current) return previous;
  return `${previous}\n\n${current}`;
}

function createStreamPublisher(
  onStream: (snapshot: InferenceStreamSnapshot) => void
): {
  update: (snapshot: InferenceStreamSnapshot, force?: boolean) => void;
  flush: () => void;
  cancel: () => void;
} {
  let latest: InferenceStreamSnapshot = {
    content: '',
    reasoning: '',
    phase: 'thinking',
    toolSteps: 0,
  };
  let lastPublished: InferenceStreamSnapshot = latest;
  let lastPublishedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const unchanged =
      latest.content === lastPublished.content &&
      latest.reasoning === lastPublished.reasoning &&
      latest.phase === lastPublished.phase &&
      latest.toolSteps === lastPublished.toolSteps;
    if (unchanged) return;
    lastPublished = latest;
    lastPublishedAt = Date.now();
    onStream(latest);
  };

  const update = (snapshot: InferenceStreamSnapshot, force = false) => {
    latest = snapshot;
    const characterDelta =
      Math.abs(snapshot.content.length - lastPublished.content.length) +
      Math.abs(snapshot.reasoning.length - lastPublished.reasoning.length);
    const elapsed = Date.now() - lastPublishedAt;
    if (force || characterDelta >= STREAM_CHARACTER_STEP || elapsed >= STREAM_INTERVAL_MS) {
      publish();
      return;
    }
    if (!timer) {
      timer = setTimeout(publish, Math.max(16, STREAM_INTERVAL_MS - elapsed));
    }
  };

  return {
    update,
    flush: publish,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function snapshotFromState(
  parser: StreamParserState,
  baseContent: string,
  baseReasoning: string,
  toolSteps: number
): InferenceStreamSnapshot {
  const raw = parser.accumulatedSnapshot || parser.tokenFallback;
  const current = splitThinkingContent(
    parser.contentSnapshot || raw,
    parser.reasoningSnapshot,
    false
  );
  const content = joinParts(baseContent, current.content);
  const reasoning = joinParts(baseReasoning, current.reasoning);
  return {
    content,
    reasoning,
    phase: content.length > 0 ? 'answering' : 'thinking',
    toolSteps,
  };
}

export async function runInferenceOrchestrator(
  userText: string,
  historySnapshot: ChatMessage[],
  toolsConfig: ToolsConfig,
  inferenceParams: InferenceParams,
  onToolCall: (call: ToolCall) => Promise<string>,
  onActivity: (kind: InferenceActivityKind, text: string) => void,
  onStream: (snapshot: InferenceStreamSnapshot) => void
): Promise<InferenceResult> {
  const context = getActiveContext();
  if (!context) throw new Error('模型运行上下文不存在，请回到模型页面重新加载模型');

  const nativeTools = buildNativeTools(toolsConfig);
  const systemContent = nativeTools.length > 0
    ? '你是运行在用户手机上的本地 AI 助手。需要外部事实、文件或媒体操作时，调用可用工具。工具返回后继续判断，可以连续调用不同工具，直到任务真正完成。不得伪造工具结果。若原生函数调用不可用，可输出紧凑 JSON：{"t":"工具名","p":{参数}}。'
    : '你是运行在用户手机上的本地 AI 助手。请直接、准确地回答。';

  const messages: NativeMessage[] = [
    { role: 'system', content: systemContent },
    ...buildHistory(historySnapshot, userText),
  ];
  const safeStop = (inferenceParams.stop ?? []).filter((item) => typeof item === 'string' && item.length > 0);
  const signatureCounts = new Map<string, number>();
  const publisher = createStreamPublisher(onStream);
  let toolSteps = 0;
  let baseContent = '';
  let baseReasoning = '';

  try {
    while (true) {
      onActivity('thinking', toolSteps === 0 ? 'AI 正在思考...' : 'AI 正在分析工具结果...');

      const parser: StreamParserState = {
        contentSnapshot: '',
        reasoningSnapshot: '',
        accumulatedSnapshot: '',
        tokenFallback: '',
      };
      let callbackToolCalls: unknown[] = [];

      // llama.rn 的 token 是增量；content、reasoning_content 和 accumulated_text
      // 是替换式累计快照。这里只追加 token，其他字段永远覆盖，避免平方级内存增长。
      // eslint-disable-next-line no-await-in-loop
      const completionResult = await context.completion(
        {
          messages: messages as Parameters<typeof context.completion>[0]['messages'],
          n_predict: inferenceParams.max_tokens,
          temperature: inferenceParams.temperature,
          top_p: inferenceParams.top_p,
          top_k: inferenceParams.top_k,
          penalty_repeat: inferenceParams.repeat_penalty,
          stop: safeStop,
          tools: nativeTools.length > 0 ? nativeTools : undefined,
          tool_choice: nativeTools.length > 0 ? 'auto' : undefined,
          reasoning_format: 'auto',
          chat_template_kwargs: { preserve_thinking: true },
        } as Parameters<typeof context.completion>[0] & {
          tools?: Array<Record<string, unknown>>;
          tool_choice?: 'auto';
          reasoning_format?: 'auto';
          chat_template_kwargs?: Record<string, unknown>;
        },
        (data: {
          token?: string;
          content?: string;
          accumulated_text?: string;
          reasoning_content?: string;
          tool_calls?: unknown[];
        }) => {
          if (typeof data.content === 'string') parser.contentSnapshot = data.content;
          if (typeof data.reasoning_content === 'string') parser.reasoningSnapshot = data.reasoning_content;
          if (typeof data.accumulated_text === 'string') {
            parser.accumulatedSnapshot = data.accumulated_text;
          } else if (
            typeof data.token === 'string' &&
            data.token &&
            typeof data.content !== 'string' &&
            typeof data.reasoning_content !== 'string'
          ) {
            parser.tokenFallback += data.token;
          }
          if (Array.isArray(data.tool_calls)) callbackToolCalls = data.tool_calls;

          const snapshot = snapshotFromState(parser, baseContent, baseReasoning, toolSteps);
          publisher.update(snapshot);
          if (snapshot.phase === 'answering') {
            onActivity('streaming', 'AI 正在输出最终回答...');
          } else if (snapshot.reasoning.length > baseReasoning.length) {
            onActivity('thinking', 'AI 正在输出思考内容...');
          }
        }
      );

      const result = completionResult as unknown as {
        content?: string;
        text?: string;
        reasoning_content?: string;
        tool_calls?: unknown[];
      };
      const rawFallback = parser.accumulatedSnapshot || parser.tokenFallback;
      const rawContent = result.content ?? parser.contentSnapshot ?? result.text ?? rawFallback;
      const rawReasoning = result.reasoning_content ?? parser.reasoningSnapshot ?? '';
      let nativeCalls = normalizeNativeToolCalls(result.tool_calls ?? callbackToolCalls);
      const fallbackCalls = nativeCalls.length === 0 ? parseToolCalls(rawContent) : [];

      if (nativeCalls.length === 0 && fallbackCalls.length > 0) {
        nativeCalls = fallbackCalls.map((call, index) => ({
          type: 'function',
          id: `fallback_${Date.now()}_${index}`,
          function: {
            name: call.toolName,
            arguments: JSON.stringify(call.parameters),
          },
        }));
      }

      let cleanContent = rawContent;
      fallbackCalls.forEach((call) => {
        cleanContent = cleanContent.replace(call.raw, '');
      });
      cleanContent = cleanContent.replace(/<\/?tool_call>/gi, '');
      const separated = splitThinkingContent(cleanContent, rawReasoning, true);

      if (nativeCalls.length === 0) {
        const combinedContent = joinParts(baseContent, separated.content);
        const combinedReasoning = joinParts(baseReasoning, separated.reasoning);
        const finalContent = combinedContent || (combinedReasoning
          ? '模型完成了思考，但没有生成最终回答。'
          : toolSteps > 0
            ? '工具执行已经结束，但模型没有生成最终回答。'
            : '模型没有返回可显示的内容。');
        publisher.update({
          content: finalContent,
          reasoning: combinedReasoning,
          phase: 'answering',
          toolSteps,
        }, true);
        publisher.flush();
        onActivity('streaming', 'AI 已完成输出');
        return { content: finalContent, reasoning: combinedReasoning, toolSteps };
      }

      baseContent = joinParts(baseContent, separated.content);
      baseReasoning = joinParts(baseReasoning, separated.reasoning);
      publisher.update({
        content: baseContent,
        reasoning: baseReasoning,
        phase: baseContent ? 'answering' : 'thinking',
        toolSteps,
      }, true);

      messages.push({
        role: 'assistant',
        content: separated.content,
        ...(separated.reasoning ? { reasoning_content: separated.reasoning } : {}),
        tool_calls: nativeCalls,
      });

      for (let index = 0; index < nativeCalls.length; index += 1) {
        const call = nativeCalls[index];
        const parameters = parseToolArguments(call);
        const signature = `${call.function.name}:${JSON.stringify(parameters)}`;
        const repeated = (signatureCounts.get(signature) ?? 0) + 1;
        signatureCounts.set(signature, repeated);

        if (repeated >= 5) {
          throw new Error(`模型连续重复调用同一工具：${call.function.name}。为避免无限循环，本次任务已停止。`);
        }

        let resultText: string;
        if (repeated >= 3) {
          resultText = `错误：同一工具和相同参数已经执行 ${repeated - 1} 次，请使用现有结果或更换参数，不要继续重复。`;
          onActivity('warning', `检测到重复工具调用：${call.function.name}`);
        } else {
          onActivity('tool_calling', `正在调用工具：${call.function.name}（${index + 1}/${nativeCalls.length}）`);
          const category = getToolCategory(call.function.name) ?? 'Files';
          const toolCall: ToolCall = {
            id: call.id,
            toolName: call.function.name,
            toolCategory: category,
            parameters,
            status: 'pending',
          };
          // eslint-disable-next-line no-await-in-loop
          resultText = await onToolCall(toolCall);
          toolSteps += 1;
          onActivity('tool_done', `工具 ${call.function.name} 已完成，继续分析...`);
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultText,
        });
      }
    }
  } finally {
    publisher.cancel();
  }
}
