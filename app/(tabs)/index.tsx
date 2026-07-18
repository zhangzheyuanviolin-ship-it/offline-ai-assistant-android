import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore, selectActiveModel } from '@/lib/store';
import { getActiveContext } from '@/lib/services/model-service';
import {
  buildCompactSystemPrompt,
  executeTool,
  getToolCategory,
  parseToolCalls,
  toolRequiresConfirmation,
} from '@/lib/services/tools-service';
import { ChatMessage, ToolCall, ToolLog } from '@/lib/types';
import { ToolConfirmationModal } from '@/components/tool-confirmation-modal';
import { router } from 'expo-router';

// ─── Inference Engine ─────────────────────────────────────────────────────────

async function runInference(
  userText: string,
  historySnapshot: ChatMessage[],
  toolsConfig: ReturnType<typeof useAppStore.getState>['toolsConfig'],
  inferenceParams: ReturnType<typeof useAppStore.getState>['inferenceParams'],
  workspaceDir: string,
  pushToken: (token: string) => void,
  onToolCall: (call: ToolCall) => Promise<string>,
  onActivity: (kind: 'thinking' | 'streaming' | 'tool_calling' | 'tool_done' | 'warning' | 'error', text: string) => void
): Promise<string> {
  const ctx = getActiveContext();
  if (!ctx) throw new Error('\u6ca1\u6709\u5df2\u52a0\u8f7d\u7684\u6a21\u578b\uff0c\u8bf7\u5148\u5728\u201c\u6a21\u578b\u201d\u9875\u9762\u52a0\u8f7d\u4e00\u4e2a GGUF \u6a21\u578b');

  const toolPrompt = buildCompactSystemPrompt(toolsConfig);
  const systemContent = `\u4f60\u662f\u4e00\u4e2a\u79bb\u7ebf AI \u52a9\u624b\uff0c\u8fd0\u884c\u5728\u7528\u6237\u624b\u673a\u4e0a\u3002\u7b80\u6d01\u56de\u7b54\uff0c\u5fc5\u8981\u65f6\u8c03\u7528\u5de5\u5177\u3002${toolPrompt}`;

  const recentHistory = historySnapshot
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20);

  const msgs: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemContent },
    ...recentHistory.map((m) => ({ role: m.role as string, content: m.content })),
    { role: 'user', content: userText },
  ];

  const safeStop = (inferenceParams.stop || []).filter((s) => typeof s === 'string' && s.length > 0);

  let fullResponse = '';
  let toolCallRound = 0;
  const MAX_TOOL_ROUNDS = 3;
  let tokenCount = 0;

  while (toolCallRound <= MAX_TOOL_ROUNDS) {
    let roundText = '';

    onActivity('streaming', `\u5df2\u751f\u6210 0 \u4e2a token...`);

    // eslint-disable-next-line no-await-in-loop
    await ctx.completion(
      {
        messages: msgs as Parameters<typeof ctx.completion>[0]['messages'],
        n_predict: inferenceParams.max_tokens,
        temperature: inferenceParams.temperature,
        top_p: inferenceParams.top_p,
        top_k: inferenceParams.top_k,
        penalty_repeat: inferenceParams.repeat_penalty,
        stop: [...safeStop, '{"t":', '```json'],
      },
      (data: { token: string }) => {
        const tok = data.token ?? '';
        if (!tok) return;
        // \u8fc7\u6ee4\u63a7\u5236\u5b57\u7b26\uff08thinking \u6807\u7b7e\u3001\u7279\u6b8a\u7b26\u53f7\uff09
        const visible = tok.replace(/<\|[^|]+?\|>/g, '');
        if (visible.length === 0) return;
        roundText += visible;
        if (toolCallRound === 0) {
          fullResponse += visible;
          tokenCount++;
          if (tokenCount % 10 === 0 || tokenCount === 1) {
            onActivity('streaming', `\u5df2\u751f\u6210 ${tokenCount} \u4e2a token...`);
          }
          pushToken(visible);
        }
      }
    );

    if (toolCallRound > 0) {
      fullResponse += roundText;
    }

    const toolCalls = parseToolCalls(roundText);
    if (toolCalls.length === 0) break;

    toolCallRound++;
    if (toolCallRound > MAX_TOOL_ROUNDS) break;

    const names = toolCalls.map((t) => t.toolName).join(', ');
    onActivity('tool_calling', `\u6b63\u5728\u8c03\u7528\u5de5\u5177\uff1a${names}...`);

    const toolResults: string[] = [];
    for (const tc of toolCalls) {
      const category = getToolCategory(tc.toolName) ?? 'Files';
      const toolCall: ToolCall = {
        id: `tc_${Date.now()}_${tc.toolName}`,
        toolName: tc.toolName,
        toolCategory: category,
        parameters: tc.parameters,
        status: 'pending',
      };

      // eslint-disable-next-line no-await-in-loop
      const resultStr = await onToolCall(toolCall);
      toolResults.push(`[${tc.toolName}\u7ed3\u679c]: ${resultStr}`);
    }

    onActivity('tool_done', `\u5de5\u5177\u5df2\u8fd4\u56de\u7ed3\u679c`);

    const toolResultContent = toolResults.join('\n');
    msgs.push({ role: 'assistant', content: roundText });
    msgs.push({ role: 'user', content: `\u5de5\u5177\u6267\u884c\u5b8c\u6210\uff1a\n${toolResultContent}\n\n\u8bf7\u6839\u636e\u4ee5\u4e0a\u7ed3\u679c\u7ee7\u7eed\u56de\u7b54\u3002` });
  }

  onActivity('streaming', `\u751f\u6210\u5b8c\u6210\uff08${tokenCount} tokens\uff09`);
  return fullResponse;
}

// ─── Parse thinking tags ─────────────────────────────────────────────────────

interface ParsedContent {
  thinking: string;
  response: string;
}

function parseThinkingTags(text: string): ParsedContent {
  // 先尝试匹配完整的 <think>...</think> 或 <thinking>...</thinking>
  const thinkMatch = text.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/);
  if (thinkMatch) {
    const thinking = thinkMatch[1].trim();
    const response = text.replace(thinkMatch[0], '').trim();
    return { thinking, response };
  }
  // 流式输出时标签可能尚未闭合：检测未闭合的 <think> 或 <thinking> 开标签
  const openMatch = text.match(/<(?:think|thinking)>([\s\S]*)$/);
  if (openMatch) {
    // 标签已开但未闭合，内容全部是思考过程
    return { thinking: openMatch[1].trim(), response: '' };
  }
  // 检测是否刚刚闭合了思考标签但回复还没开始
  const closedButEmpty = text.match(/^\s*<\/(?:think|thinking)>\s*$/);
  if (closedButEmpty) {
    return { thinking: '', response: '' };
  }
  return { thinking: '', response: text };
}

// ─── Activity Message ────────────────────────────────────────────────────────

const ActivityMessage = memo(function ActivityMessage({
  item,
  colors,
}: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const icon =
    item.activityType === 'tool_calling' ? '\ud83d\udee0\ufe0f' :
    item.activityType === 'tool_done' ? '\u2705' :
    item.activityType === 'streaming' ? '\u270d\ufe0f' :
    item.activityType === 'warning' ? '\u26a0\ufe0f' :
    item.activityType === 'error' ? '\u274c' : '\ud83d\udcad';
  return (
    <View
      style={[styles.activityRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
      accessible
      accessibilityLabel={`\u7cfb\u7edf\u63d0\u793a\uff1a${item.content}`}
    >
      <Text style={[styles.activityIcon]}>{icon}</Text>
      <Text style={[styles.activityText, { color: colors.muted }]} numberOfLines={3}>
        {item.content}
      </Text>
    </View>
  );
});

// ─── Message Item ────────────────────────────────────────────────────────────

const MessageItem = memo(function MessageItem({
  item,
  colors,
}: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const isUser = item.role === 'user';
  const { thinking, response } = isUser ? { thinking: '', response: item.content } : parseThinkingTags(item.content);
  const [showThinking, setShowThinking] = useState(false);

  return (
    <View
      style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]}
      accessible
      accessibilityLabel={`${isUser ? '\u60a8' : 'AI'}\uff1a${response || item.content}`}
      accessibilityRole="text"
    >
      <View
        style={[
          styles.msgBubble,
          {
            backgroundColor: isUser ? colors.primary : colors.surface,
            borderColor: isUser ? colors.primary : colors.border,
          },
        ]}
      >
        {/* \u601d\u8003\u5185\u5bb9\uff08\u53ef\u6298\u53e0\uff09 */}
        {!isUser && thinking.length > 0 && (
          <View style={styles.thinkingContainer}>
            <TouchableOpacity
n              onPress={() => setShowThinking(!showThinking)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${showThinking ? '\u9690\u85cf' : '\u5c55\u5f00'}\u601d\u8003\u8fc7\u7a0b`}
              style={styles.thinkingToggle}
            >
              <Text style={[styles.thinkingToggleText, { color: colors.muted }]}>
                {showThinking ? '\u25bc \u601d\u8003\u8fc7\u7a0b' : '\u25b6 \u601d\u8003\u8fc7\u7a0b'}
              </Text>
            </TouchableOpacity>
            {showThinking && (
              <View style={[styles.thinkingContent, { borderColor: colors.border }]} accessible accessibilityLabel="\u601d\u8003\u8fc7\u7a0b\u5185\u5bb9">
                <Text style={[styles.thinkingText, { color: colors.muted }]}>
                  {thinking}
                </Text>
              </View>
            )}
          </View>
        )}
        {/* \u6b63\u6587\u5185\u5bb9 */}
        <Text
          style={[
            styles.msgText,
            { color: isUser ? '#fff' : colors.foreground },
          ]}
          selectable
        >
          {response || item.content}
        </Text>
      </View>
      <Text style={[styles.msgTime, { color: colors.muted }]}>
        {new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );
});

// ─── Streaming Message (\u6d41\u5f0f\u8f93\u51fa\u4e13\u7528\u7ec4\u4ef6\uff0c\u4e0d\u8d70 store) ───────────────

const StreamingMessage = memo(function StreamingMessage({
  content,
  activityText,
  colors,
}: {
  content: string;
  activityText: string;
  colors: ReturnType<typeof useColors>;
}) {
  // \u89e3\u6790 thinking \u6807\u7b7e
  const { thinking, response } = parseThinkingTags(content);
  const [showThinking, setShowThinking] = useState(false);

  return (
    <View style={[styles.msgRow, styles.msgRowAssistant]} accessible accessibilityLabel={`AI\uff1a${response || content || activityText}`} accessibilityRole="text">
      <View
        style={[
          styles.msgBubble,
          {
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
      >
        {/* \u601d\u8003\u5185\u5bb9 */}
        {thinking.length > 0 && (
          <View style={styles.thinkingContainer}>
            <TouchableOpacity
n              onPress={() => setShowThinking(!showThinking)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${showThinking ? '\u9690\u85cf' : '\u5c55\u5f00'}\u601d\u8003\u8fc7\u7a0b`}
              style={styles.thinkingToggle}
            >
              <Text style={[styles.thinkingToggleText, { color: colors.muted }]}>
                {showThinking ? '\u25bc \u601d\u8003\u8fc7\u7a0b' : '\u25b6 \u601d\u8003\u8fc7\u7a0b'}
              </Text>
            </TouchableOpacity>
            {showThinking && (
              <View style={[styles.thinkingContent, { borderColor: colors.border }]} accessible accessibilityLabel="\u601d\u8003\u8fc7\u7a0b\u5185\u5bb9">
                <Text style={[styles.thinkingText, { color: colors.muted }]}>
                  {thinking}
                </Text>
              </View>
            )}
          </View>
        )}
        {/* \u6b63\u6587 */}
        {!response && !thinking && (
          <View style={styles.typingIndicator}>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text style={[styles.typingText, { color: colors.muted }]}>{activityText}</Text>
          </View>
        )}
        {(response || (thinking && !response)) && (
          <Text
            style={[styles.msgText, { color: colors.foreground }]}
            selectable
          >
            {response || ''}
            {'\u258c'}
          </Text>
        )}
      </View>
      {/* activity \u63d0\u793a\u884c */}
      <Text style={[styles.streamActivity, { color: colors.muted }]} numberOfLines={1}>
        {activityText}
      </Text>
    </View>
  );
});

// ─── Chat Screen ─────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const colors = useColors();
  const [inputText, setInputText] = useState('');
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  const [resolveToolCall, setResolveToolCall] = useState<((result: string) => void) | null>(null);
  const flatListRef = useRef<FlatList>(null);

  // \u6d41\u5f0f\u8f93\u51fa\u7684\u7eaf\u672c\u5730\u72b6\u6001\uff08\u4e0d\u8d70 store\uff0c\u907f\u514d FlatList \u5168\u91cf\u91cd\u6e32\u67d3\uff09
  const [streamContent, setStreamContent] = useState('');
  const [streamActivity, setStreamActivity] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  const {
    messages,
    isGenerating,
    toolsConfig,
    inferenceParams,
    workspaceDir,
    addMessage,
    removeMessage,
    addLog,
    setGenerating,
    setError,
    setWorkspaceDir,
  } = useAppStore();

  const activeModel = useAppStore(selectActiveModel);

  // \u521d\u59cb\u5316\uff1a\u52a0\u8f7d\u5b58\u50a8\u6570\u636e + \u540c\u6b65\u6a21\u578b\u52a0\u8f7d\u72b6\u6001
  useEffect(() => {
    useAppStore.getState().loadModelsFromStorage().then(() => {
      useAppStore.getState().syncModelLoadedState();
    });
  }, []);

  // AppState \u76d1\u542c\uff1a\u5e94\u7528\u56de\u5230\u524d\u53f0\u65f6\u540c\u6b65\u6a21\u578b\u72b6\u6001
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        useAppStore.getState().syncModelLoadedState();
      }
    });
    return () => sub.remove();
  }, []);

  // \u521d\u59cb\u5316\u5de5\u4f5c\u533a
  useEffect(() => {
    if (!workspaceDir) {
      try {
        const { FileSystem } = require('expo-file-system/legacy');
        const base = FileSystem.documentDirectory || 'file:///data/data/space.manus.offline.ai.assistant.t20260106034740/files/';
        const basePath = base.startsWith('file://') ? base.slice('file://'.length) : base;
        const dir = basePath.replace(/\/+$/, '') + '/workspace';
        setWorkspaceDir(dir);
      } catch {
        setWorkspaceDir('/data/data/space.manus.offline.ai.assistant.t20260106034740/files/workspace');
      }
    }
  }, [workspaceDir, setWorkspaceDir]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  useEffect(() => {
    if (messages.length > 0 || isStreaming) scrollToBottom();
  }, [messages.length, isStreaming, scrollToBottom]);

  // \u5de5\u5177\u8c03\u7528\u5904\u7406
  const handleToolCall = useCallback(
    (toolCall: ToolCall): Promise<string> => {
      return new Promise((resolve) => {
        const needsConfirm = toolRequiresConfirmation(toolCall.toolName, toolsConfig);
        if (!needsConfirm) {
          const startMs = Date.now();
          const ws = useAppStore.getState().workspaceDir;
          executeTool(toolCall.toolName, toolCall.toolCategory, toolCall.parameters, toolsConfig, ws)
            .then((result) => {
              const log: ToolLog = {
                id: `log_${Date.now()}`,
                timestamp: Date.now(),
                toolName: toolCall.toolName,
                toolCategory: toolCall.toolCategory,
                parameters: toolCall.parameters,
                result,
                userConfirmed: false,
                executionTimeMs: Date.now() - startMs,
              };
              addLog(log);
              resolve(result.success ? JSON.stringify(result.data) : `\u9519\u8bef: ${result.error}`);
            })
            .catch((err: Error) => resolve(`\u6267\u884c\u5931\u8d25: ${err.message}`));
        } else {
          setPendingToolCall(toolCall);
          setResolveToolCall(() => resolve);
        }
      });
    },
    [toolsConfig, addLog]
  );

  const handleConfirmTool = useCallback(async () => {
    if (!pendingToolCall || !resolveToolCall) return;
    setPendingToolCall(null);
    const startMs = Date.now();
    const ws = useAppStore.getState().workspaceDir;
    const result = await executeTool(
      pendingToolCall.toolName,
      pendingToolCall.toolCategory,
      pendingToolCall.parameters,
      toolsConfig,
      ws
    );
    const log: ToolLog = {
      id: `log_${Date.now()}`,
      timestamp: Date.now(),
      toolName: pendingToolCall.toolName,
      toolCategory: pendingToolCall.toolCategory,
      parameters: pendingToolCall.parameters,
      result,
      userConfirmed: true,
      executionTimeMs: Date.now() - startMs,
    };
    addLog(log);
    resolveToolCall(result.success ? JSON.stringify(result.data) : `\u9519\u8bef: ${result.error}`);
    setResolveToolCall(null);
  }, [pendingToolCall, resolveToolCall, toolsConfig, addLog]);

  const handleCancelTool = useCallback(() => {
    if (!pendingToolCall || !resolveToolCall) return;
    setPendingToolCall(null);
    resolveToolCall('\u7528\u6237\u53d6\u6d88\u4e86\u6b64\u64cd\u4f5c');
    setResolveToolCall(null);
  }, [pendingToolCall, resolveToolCall]);

  // \u521b\u5efa token \u63a8\u9001\u5668\uff08\u7eaf\u672c\u5730 useState\uff0c\u4e0d\u8d70 store\uff09
  const createPushToken = useCallback(() => {
    let pending = '';
    let timerHandle: number | null = null;
    let baseContent = '';

    const flush = () => {
      timerHandle = null;
      if (pending.length > 0) {
        const next = baseContent + pending;
        pending = '';
        baseContent = next;
        setStreamContent(next);
      }
    };

    return {
      push(token: string) {
        pending += token;
        if (timerHandle == null) {
          timerHandle = setTimeout(flush, 80) as unknown as number;
        }
      },
      flush() {
        if (timerHandle != null) {
          clearTimeout(timerHandle as unknown as ReturnType<typeof setTimeout>);
          timerHandle = null;
        }
        flush();
      },
      cancel() {
        if (timerHandle != null) {
          clearTimeout(timerHandle as unknown as ReturnType<typeof setTimeout>);
          timerHandle = null;
        }
        pending = '';
      },
    };
  }, []);

  // \u53d1\u9001\u6d88\u606f
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isGenerating) return;

    if (!activeModel?.isLoaded) {
      Alert.alert(
        '\u672a\u52a0\u8f7d\u6a21\u578b',
        '\u8bf7\u5148\u5728\u201c\u6a21\u578b\u201d\u9875\u9762\u52a0\u8f7d\u4e00\u4e2a GGUF \u6a21\u578b',
        [{ text: '\u53bb\u52a0\u8f7d', onPress: () => router.push('/(tabs)/models') }, { text: '\u53d6\u6d88' }]
      );
      return;
    }

    setInputText('');
    setGenerating(true);
    setError(null);

    // \u7528\u6237\u6d88\u606f\u7acb\u5373\u5199\u5165 store\uff08\u4f9b\u6301\u4e45\u5316\uff09
    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(userMsg);

    // \u5f00\u59cb\u6d41\u5f0f\u8f93\u51fa\uff08\u7eaf\u672c\u5730\u72b6\u6001\uff0c\u4e0d\u8d70 store\uff09
    setIsStreaming(true);
    setStreamContent('');
    setStreamActivity('AI \u6b63\u5728\u601d\u8003...');
    const pusher = createPushToken();

    try {
      const currentMessages = useAppStore.getState().messages;
      const currentParams = useAppStore.getState().inferenceParams;
      const currentTools = useAppStore.getState().toolsConfig;
      const ws = useAppStore.getState().workspaceDir;

      // \u8ba9 UI \u6709\u673a\u4f1a\u6e32\u67d3\u521d\u59cb\u72b6\u6001
      await new Promise((r) => setTimeout(r, 50));

      const finalText = await runInference(
        text,
        currentMessages,
        currentTools,
        currentParams,
        ws,
        (token) => pusher.push(token),
        handleToolCall,
        (kind, txt) => {
          if (kind === 'streaming') {
            setStreamActivity(txt);
          } else {
            setStreamActivity(txt);
          }
        }
      );

      // flush \u6b8b\u4f59 token
      pusher.flush();

      // \u7ed3\u675f\u6d41\u5f0f\u8f93\u51fa
      setIsStreaming(false);
      setStreamContent('');
      setStreamActivity('');

      // \u4e00\u6b21\u6027\u5199\u5165 store\uff08\u4f9b\u6301\u4e45\u5316\uff09
      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: finalText,
        timestamp: Date.now(),
      };
      addMessage(assistantMsg);
    } catch (err) {
      pusher.cancel();
      setIsStreaming(false);
      const errMsg = err instanceof Error ? err.message : '\u63a8\u7406\u5931\u8d25';
      setStreamContent('');
      setStreamActivity('');

      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: `\u274c ${errMsg}`,
        timestamp: Date.now(),
      };
      addMessage(assistantMsg);
      setError(errMsg);
    } finally {
      setGenerating(false);
    }
  }, [
    inputText,
    isGenerating,
    activeModel,
    addMessage,
    addLog,
    setGenerating,
    setError,
    handleToolCall,
    createPushToken,
  ]);

  const handleClearChat = useCallback(() => {
    Alert.alert('\u6e05\u7a7a\u5bf9\u8bdd', '\u786e\u5b9a\u8981\u6e05\u7a7a\u6240\u6709\u5bf9\u8bdd\u8bb0\u5f55\u5417\uff1f', [
      { text: '\u53d6\u6d88', style: 'cancel' },
      { text: '\u6e05\u7a7a', style: 'destructive', onPress: () => useAppStore.getState().clearMessages() },
    ]);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => {
      return <MessageItem item={item} colors={colors} />;
    },
    [colors]
  );

  // \u7ec4\u5408\u5217\u8868\u6570\u636e\uff1astore \u6d88\u606f + \u6d41\u5f0f\u8f93\u51fa\u5360\u4f4d
  const listData = isStreaming
    ? [...messages, { id: '__streaming__', isStreaming: true, content: streamContent, role: 'assistant', timestamp: Date.now(), _activity: streamActivity } as unknown as ChatMessage]
    : messages;

  const renderStreamingItem = useCallback(({ item }: { item: ChatMessage }) => {
    if ((item as any).id === '__streaming__') {
      return <StreamingMessage content={streamContent} activityText={streamActivity} colors={colors} />;
    }
    return <MessageItem item={item} colors={colors} />;
  }, [colors, streamContent, streamActivity]);

  return (
    <ScreenContainer>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <TouchableOpacity
          style={[styles.modelChip, { backgroundColor: colors.background, borderColor: colors.border }]}
          onPress={() => router.push('/(tabs)/models')}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`\u5f53\u524d\u6a21\u578b\uff1a${activeModel ? activeModel.name : '\u672a\u52a0\u8f7d\u6a21\u578b'}\uff0c\u53cc\u51fb\u5207\u6362`}
        >
          <Text style={[styles.modelDot, { color: activeModel?.isLoaded ? colors.success : colors.muted }]}>
            {activeModel?.isLoaded ? '\u25cf' : '\u25cb'}
          </Text>
          <Text style={[styles.modelChipText, { color: colors.foreground }]} numberOfLines={1}>
            {activeModel ? activeModel.name : '\u70b9\u51fb\u52a0\u8f7d\u6a21\u578b'}
          </Text>
        </TouchableOpacity>

        <View style={styles.headerRight}>
          <View style={styles.toolChips}>
            {(
              [
                { key: 'WebSearch', label: '\u641c', icon: '\ud83d\udd0d' },
                { key: 'Files', label: '\u6587', icon: '\ud83d\udcc1' },
                { key: 'Media', label: '\u5a92', icon: '\ud83c\udfac' },
              ] as const
            ).map(({ key, label, icon }) => {
              const enabled = toolsConfig[key].enabled;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.toolChip,
                    {
                      backgroundColor: enabled ? colors.primary + '22' : colors.surface,
                      borderColor: enabled ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => router.push('/(tabs)/tools-settings')}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`${label}\u5de5\u5177${enabled ? '\u5df2\u542f\u7528' : '\u5df2\u7981\u7528'}\uff0c\u53cc\u51fb\u8fdb\u5165\u5de5\u5177\u8bbe\u7f6e`}
                >
                  <Text style={[styles.toolChipText, { color: enabled ? colors.primary : colors.muted }]}>
                    {icon}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {messages.length > 0 && (
            <TouchableOpacity
              style={[styles.clearBtn, { borderColor: colors.border }]}
              onPress={handleClearChat}
              accessible
              accessibilityRole="button"
              accessibilityLabel="\u6e05\u7a7a\u5bf9\u8bdd\u8bb0\u5f55"
            >
              <Text style={[styles.clearBtnText, { color: colors.muted }]}>\u6e05\u7a7a</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Messages */}
      <View style={styles.flex}>
        {listData.length === 0 ? (
          <View style={styles.emptyState} accessible accessibilityLabel="\u6b22\u8fce\u4f7f\u7528\u79bb\u7ebf AI \u52a9\u624b\uff0c\u8bf7\u5148\u52a0\u8f7d\u6a21\u578b\u540e\u5f00\u59cb\u5bf9\u8bdd">
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>\u79bb\u7ebf AI \u52a9\u624b</Text>
            <Text style={[styles.emptyDesc, { color: colors.muted }]}>
              \u6240\u6709\u63a8\u7406\u5728\u672c\u5730\u8bbe\u5907\u8fd0\u884c\uff0c\u65e0\u9700\u7f51\u7edc\u3002{'\n'}
              \u652f\u6301\u6587\u4ef6\u7ba1\u7406\u3001\u591a\u5a92\u4f53\u5904\u7406\u548c\u7f51\u7edc\u641c\u7d22\u5de5\u5177\u3002{'\n'}
              \u5de5\u4f5c\u533a\uff1a{workspaceDir || '\u52a0\u8f7d\u4e2d...'}
            </Text>
            {!activeModel?.isLoaded && (
              <TouchableOpacity
                style={[styles.loadModelBtn, { backgroundColor: colors.primary }]}
                onPress={() => router.push('/(tabs)/models')}
                accessible
                accessibilityRole="button"
                accessibilityLabel="\u524d\u5f80\u52a0\u8f7d\u6a21\u578b"
              >
                <Text style={styles.loadModelBtnText}>\ud83d\udce6 \u52a0\u8f7d\u6a21\u578b</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={listData}
            keyExtractor={(item) => item.id}
            renderItem={isStreaming ? renderStreamingItem : renderItem}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={scrollToBottom}
            removeClippedSubviews={false}
            accessible={false}
          />
        )}

        {/* Input */}
        <View style={[styles.inputBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <TextInput
            style={[
              styles.textInput,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.foreground,
              },
            ]}
            value={inputText}
            onChangeText={setInputText}
            placeholder={activeModel?.isLoaded ? '\u8f93\u5165\u6d88\u606f...' : '\u8bf7\u5148\u52a0\u8f7d\u6a21\u578b'}
            placeholderTextColor={colors.muted}
            multiline
            maxLength={4000}
            editable={!isGenerating && !!activeModel?.isLoaded}
            returnKeyType="default"
            accessible
                        accessibilityLabel="\u6d88\u606f\u8f93\u5165\u6846"
            accessibilityHint={activeModel?.isLoaded ? '\u8f93\u5165\u60a8\u7684\u6d88\u606f\uff0c\u7136\u540e\u70b9\u51fb\u53d1\u9001' : '\u8bf7\u5148\u5728\u6a21\u578b\u9875\u9762\u52a0\u8f7d\u4e00\u4e2a GGUF \u6a21\u578b'}
          />
          <TouchableOpacity
            style={[
              styles.sendBtn,
              {
                backgroundColor:
                  isGenerating || !activeModel?.isLoaded || !inputText.trim()
                    ? colors.border
                    : colors.primary,
              },
            ]}
            onPress={handleSend}
            disabled={isGenerating || !activeModel?.isLoaded || !inputText.trim()}
            accessible
            accessibilityRole="button"
            accessibilityLabel={isGenerating ? '\u6b63\u5728\u751f\u6210\u56de\u590d\uff0c\u8bf7\u7a0d\u5019' : '\u53d1\u9001\u6d88\u606f'}
            accessibilityHint="\u53cc\u51fb\u53d1\u9001\u6d88\u606f"
          >
            {isGenerating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendBtnText}>\u53d1\u9001</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Tool Confirmation Modal */}
      <ToolConfirmationModal
        visible={!!pendingToolCall}
        toolCall={pendingToolCall}
        onConfirm={handleConfirmTool}
        onCancel={handleCancelTool}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  },
  modelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    gap: 4,
    maxWidth: '55%',
  },
  modelDot: { fontSize: 12 },
  modelChipText: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolChips: { flexDirection: 'row', gap: 4 },
  toolChip: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolChipText: { fontSize: 14 },
  clearBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
  },
  clearBtnText: { fontSize: 12, fontWeight: '500' },
  messageList: { padding: 12, gap: 8, paddingBottom: 16 },
  msgRow: { marginBottom: 4 },
  msgRowUser: { alignItems: 'flex-end' },
  msgRowAssistant: { alignItems: 'flex-start' },
  msgBubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: 'center',
  },
  msgText: { fontSize: 15, lineHeight: 22 },
  msgTime: { fontSize: 11, marginTop: 3, marginHorizontal: 4 },
  typingIndicator: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typingText: { fontSize: 13 },
  streamActivity: { fontSize: 11, marginTop: 3, marginHorizontal: 4, fontStyle: 'italic' },
  // \u601d\u8003\u8fc7\u7a0b\u6837\u5f0f
  thinkingContainer: { marginBottom: 8 },
  thinkingToggle: { paddingVertical: 4, paddingHorizontal: 8, alignSelf: 'flex-start', borderRadius: 8 },
  thinkingToggleText: { fontSize: 12, fontWeight: '500' },
  thinkingContent: {
    marginTop: 4,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  thinkingText: { fontSize: 13, lineHeight: 18, fontStyle: 'italic' },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  emptyTitle: { fontSize: 24, fontWeight: '700' },
  emptyDesc: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  loadModelBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 8,
  },
  loadModelBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  // \u8f93\u5165\u533a\u57df\uff1a\u4e0d\u7528 KeyboardAvoidingView\uff0c\u76f4\u63a5\u56fa\u5b9a\u5728\u5e95\u90e8
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    gap: 8,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    lineHeight: 22,
    maxHeight: 120,
    minHeight: 44,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '85%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  activityIcon: { fontSize: 14 },
  activityText: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
});