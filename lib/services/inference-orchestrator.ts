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

function stripControlTokens(text: string): string {
  return text.replace(/<\|[^|]+?\|>/g, '').trim();
}

function splitLegacyThinking(content: string, nativeReasoning: string): { content: string; reasoning: string } {
  const normalized = stripControlTokens(content);
  const reasoning = stripControlTokens(nativeReasoning);
  if (reasoning) return { content: normalized, reasoning };

  const complete = normalized.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
  if (complete) {
    return {
      reasoning: complete[1].trim(),
      content: normalized.replace(complete[0], '').trim(),
    };
  }

  const closing = normalized.match(/<\/(?:think|thinking)>/i);
  if (closing && closing.index !== undefined) {
    return {
      reasoning: normalized.slice(0, closing.index).trim(),
      content: normalized.slice(closing.index + closing[0].length).trim(),
    };
  }

  return { content: normalized, reasoning: '' };
}

function normalizeNativeToolCalls(raw: unknown): NativeToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: NativeToolCall[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const value = entry as {
      id?: string;
      type?: string;
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

export async function runInferenceOrchestrator(
  userText: string,
  historySnapshot: ChatMessage[],
  toolsConfig: ToolsConfig,
  inferenceParams: InferenceParams,
  onToolCall: (call: ToolCall) => Promise<string>,
  onActivity: (kind: InferenceActivityKind, text: string) => void
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
  let toolSteps = 0;

  while (true) {
    onActivity('thinking', toolSteps === 0 ? 'AI 正在思考...' : 'AI 正在分析工具结果...');

    let callbackContent = '';
    let callbackTokenContent = '';
    let callbackReasoning = '';
    let callbackToolCalls: unknown[] = [];

    // llama.rn 的 content/reasoning_content 是累计字符串，不能逐次追加；
    // 只有 token 是增量。错误地追加累计 content 会造成平方级内存增长和无障碍卡死。
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
        if (typeof data.content === 'string') {
          callbackContent = data.content;
        } else if (typeof data.accumulated_text === 'string') {
          callbackContent = data.accumulated_text;
        } else if (typeof data.token === 'string' && data.token) {
          callbackTokenContent += data.token;
          callbackContent = callbackTokenContent;
        }
        if (typeof data.reasoning_content === 'string') callbackReasoning = data.reasoning_content;
        if (Array.isArray(data.tool_calls)) callbackToolCalls = data.tool_calls;
      }
    );

    const result = completionResult as unknown as {
      content?: string;
      text?: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
      interrupted?: boolean;
    };
    const rawContent = result.content ?? callbackContent ?? result.text ?? '';
    const rawReasoning = result.reasoning_content ?? callbackReasoning ?? '';
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
    cleanContent = cleanContent.replace(/<\/?tool_call>/gi, '').trim();
    const separated = splitLegacyThinking(cleanContent, rawReasoning);

    if (nativeCalls.length === 0) {
      const finalContent = separated.content || (separated.reasoning
        ? '模型完成了思考，但没有生成最终回答。'
        : toolSteps > 0
          ? '工具执行已经结束，但模型没有生成最终回答。'
          : '模型没有返回可显示的内容。');
      onActivity('streaming', 'AI 已生成最终回答');
      return { content: finalContent, reasoning: separated.reasoning, toolSteps };
    }

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
}
