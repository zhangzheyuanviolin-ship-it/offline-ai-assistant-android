import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
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

/**
 * 运行本地推理，支持极简工具调用格式
 * 工具调用格式：{"t":"工具名","p":{参数}}
 *
 * 关键修复：
 * - onToken 不再依赖闭包中的 messages；改为每次回调累加到 roundText 并通过
 *   onTokenRef.current 转发最新内容。UI 端用 RAF 节流，避免每个 token 都触发整棵
 *   消息树重渲染导致主线程雪崩崩溃。
 */
async function runInference(
  userText: string,
  history: ChatMessage[],
  toolsConfig: ReturnType<typeof useAppStore.getState>['toolsConfig'],
  inferenceParams: ReturnType<typeof useAppStore.getState>['inferenceParams'],
  workspaceDir: string,
  onToken: (token: string) => void,
  onToolCall: (call: ToolCall) => Promise<string>,
  onActivity: (kind: 'thinking' | 'tool_calling' | 'tool_done' | 'warning' | 'error', text: string) => void
): Promise<string> {
  const ctx = getActiveContext();
  if (!ctx) throw new Error('没有已加载的模型，请先在"模型"页面加载一个 GGUF 模型');

  // 构建极简系统提示（工具描述 < 200 token）
  const toolPrompt = buildCompactSystemPrompt(toolsConfig);
  const systemContent = `你是一个离线 AI 助手，运行在用户手机上。简洁回答，必要时调用工具。${toolPrompt}`;

  // 仅保留最近 20 条历史节省上下文
  const recentHistory = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20);

  const msgs: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemContent },
    ...recentHistory.map((m) => ({ role: m.role as string, content: m.content })),
    { role: 'user', content: userText },
  ];

  // 过滤空字符串 stop token（之前包含两个空串，可能导致 llama.rn 异常）
  const safeStop = (inferenceParams.stop || []).filter((s) => typeof s === 'string' && s.length > 0);

  let fullResponse = '';
  let toolCallRound = 0;
  const MAX_TOOL_ROUNDS = 3;

  while (toolCallRound <= MAX_TOOL_ROUNDS) {
    let roundText = '';

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
        roundText += tok;
        if (toolCallRound === 0) {
          fullResponse += tok;
          onToken(tok);
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
    onActivity('tool_calling', `正在调用工具：${names}...`);

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

      const resultStr = await onToolCall(toolCall);
      toolResults.push(`[${tc.toolName}结果]: ${resultStr}`);
    }

    onActivity('tool_done', `工具已返回结果`);

    const toolResultContent = toolResults.join('\n');
    msgs.push({ role: 'assistant', content: roundText });
    msgs.push({ role: 'user', content: `工具执行完成：\n${toolResultContent}\n\n请根据以上结果继续回答。` });
  }

  return fullResponse;
}

// ─── Streaming Buffer Hook (RAF-throttled) ────────────────────────────────────

interface StreamBuffer {
  /** 推入一个 token，立即累加但不立刻触发 UI 更新 */
  push(token: string): void;
  /** 强制 flush（推理结束时调用） */
  flush(): void;
  /** 取消（如出错时） */
  cancel(): void;
}

/**
 * 创建流式输出缓冲：通过 requestAnimationFrame 将一帧内的多个 token 合并为一次
 * setState 调用。重渲染频率从"每个 token 一次"降到"每秒最多 60 次"。
 */
function createStreamBuffer(
  getCurrent: () => string,
  applyUpdate: (newContent: string) => void
): StreamBuffer {
  let pending = '';
  let rafHandle: number | null = null;

  const flush = () => {
    rafHandle = null;
    if (pending.length > 0) {
      const next = getCurrent() + pending;
      pending = '';
      applyUpdate(next);
    }
  };

  return {
    push(token: string) {
      pending += token;
      if (rafHandle == null) {
        if (typeof requestAnimationFrame !== 'undefined') {
          rafHandle = requestAnimationFrame(flush);
        } else {
          // Fallback: 16ms 定时器
          rafHandle = setTimeout(flush, 16) as unknown as number;
        }
      }
    },
    flush() {
      if (rafHandle != null) {
        if (typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(rafHandle);
        } else {
          clearTimeout(rafHandle as unknown as ReturnType<typeof setTimeout>);
        }
        rafHandle = null;
      }
      flush();
    },
    cancel() {
      if (rafHandle != null) {
        if (typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(rafHandle);
        } else {
          clearTimeout(rafHandle as unknown as ReturnType<typeof setTimeout>);
        }
        rafHandle = null;
      }
      pending = '';
    },
  };
}

// ─── Activity Message (轻量提示行) ─────────────────────────────────────────────

const ActivityMessage = memo(function ActivityMessage({
  item,
  colors,
}: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const icon =
    item.activityType === 'tool_calling' ? '🛠️' :
    item.activityType === 'tool_done' ? '✅' :
    item.activityType === 'warning' ? '⚠️' :
    item.activityType === 'error' ? '❌' : '💭';
  return (
    <View style={[styles.activityRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.activityIcon]}>{icon}</Text>
      <Text style={[styles.activityText, { color: colors.muted }]} numberOfLines={2}>
        {item.content}
      </Text>
    </View>
  );
});

// ─── Message Item (memo 化，跳过未变化消息的重渲染) ────────────────────────────

const MessageItem = memo(function MessageItem({
  item,
  colors,
}: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const isUser = item.role === 'user';
  return (
    <View
      style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]}
      accessible
      accessibilityLabel={`${isUser ? '您' : 'AI'}：${item.content}`}
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
        {item.isStreaming && !item.content ? (
          <View style={styles.typingIndicator}>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text style={[styles.typingText, { color: colors.muted }]}>正在思考...</Text>
          </View>
        ) : (
          <Text
            style={[
              styles.msgText,
              { color: isUser ? '#fff' : colors.foreground },
            ]}
            selectable
          >
            {item.content}
            {item.isStreaming ? '▌' : ''}
          </Text>
        )}
      </View>
      <Text style={[styles.msgTime, { color: colors.muted }]}>
        {new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
  );
});

// ─── Chat Screen ──────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const colors = useColors();
  const [inputText, setInputText] = useState('');
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  const [resolveToolCall, setResolveToolCall] = useState<((result: string) => void) | null>(null);
  const flatListRef = useRef<FlatList>(null);

  const {
    messages,
    isGenerating,
    toolsConfig,
    inferenceParams,
    workspaceDir,
    addMessage,
    updateMessage,
    removeMessage,
    addLog,
    setGenerating,
    setError,
    setWorkspaceDir,
  } = useAppStore();

  const activeModel = useAppStore(selectActiveModel);

  // 初始化工作区：如果未设置，使用 FileSystem.documentDirectory + 'workspace/'
  useEffect(() => {
    if (!workspaceDir) {
      // 动态加载避免在 SSR 阶段崩溃
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

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages.length, scrollToBottom]);

  // 工具调用处理（workspaceDir 通过闭包从最新 store 获取）
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
              resolve(result.success ? JSON.stringify(result.data) : `错误: ${result.error}`);
            })
            .catch((err: Error) => resolve(`执行失败: ${err.message}`));
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
    resolveToolCall(result.success ? JSON.stringify(result.data) : `错误: ${result.error}`);
    setResolveToolCall(null);
  }, [pendingToolCall, resolveToolCall, toolsConfig, addLog]);

  const handleCancelTool = useCallback(() => {
    if (!pendingToolCall || !resolveToolCall) return;
    setPendingToolCall(null);
    resolveToolCall('用户取消了此操作');
    setResolveToolCall(null);
  }, [pendingToolCall, resolveToolCall]);

  // 添加 activity 提示消息（独立的轻量行，不参与 assistant content）
  const addActivity = useCallback(
    (kind: ChatMessage['activityType'], text: string, id?: string) => {
      const msg: ChatMessage = {
        id: id ?? `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'system',
        content: text,
        timestamp: Date.now(),
        isActivity: true,
        activityType: kind,
      };
      addMessage(msg);
      // 30 秒后自动清理（避免堆积）
      setTimeout(() => {
        try { removeMessage(msg.id); } catch {}
      }, 30000);
      return msg.id;
    },
    [addMessage, removeMessage]
  );

  // 发送消息
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isGenerating) return;

    if (!activeModel?.isLoaded) {
      Alert.alert(
        '未加载模型',
        '请先在"模型"页面加载一个 GGUF 模型',
        [{ text: '去加载', onPress: () => router.push('/(tabs)/models') }, { text: '取消' }]
      );
      return;
    }

    setInputText('');
    setGenerating(true);
    setError(null);

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(userMsg);

    const assistantMsgId = `msg_${Date.now() + 1}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    addMessage(assistantMsg);

    // 1. 思考提示
    const thinkingId = addActivity('thinking', 'AI 正在思考...');

    // 2. 创建流式缓冲（破闭包 + RAF 节流）
    let lastContentRef = { value: '' };
    let buffer: StreamBuffer | null = null;

    try {
      const ws = useAppStore.getState().workspaceDir;

      buffer = createStreamBuffer(
        () => lastContentRef.value,
        (next) => {
          lastContentRef.value = next;
          updateMessage(assistantMsgId, { content: next });
        }
      );

      const finalText = await runInference(
        text,
        messages,
        toolsConfig,
        inferenceParams,
        ws,
        (token) => buffer!.push(token),
        handleToolCall,
        (kind, txt) => {
          // 移除"思考中"提示（如果还在）
          try { removeMessage(thinkingId); } catch {}
          addActivity(kind, txt);
        }
      );

      // flush 残余 token
      buffer.flush();
      // 移除所有 activity 提示（保留日志）
      // 推理完成后统一清理：把 messages 中所有 isActivity=true 的删除
      useAppStore.setState((state) => ({
        messages: state.messages.filter((m) => !m.isActivity),
      }));

      updateMessage(assistantMsgId, { content: finalText, isStreaming: false });
    } catch (err) {
      buffer?.cancel();
      const errMsg = err instanceof Error ? err.message : '推理失败';
      try { removeMessage(thinkingId); } catch {}
      addActivity('error', `推理失败：${errMsg}`);
      updateMessage(assistantMsgId, { content: `❌ ${errMsg}`, isStreaming: false });
      setError(errMsg);
    } finally {
      setGenerating(false);
    }
  }, [
    inputText,
    isGenerating,
    activeModel,
    messages,
    toolsConfig,
    inferenceParams,
    addMessage,
    updateMessage,
    removeMessage,
    addLog,
    setGenerating,
    setError,
    handleToolCall,
    addActivity,
  ]);

  const handleClearChat = useCallback(() => {
    Alert.alert('清空对话', '确定要清空所有对话记录吗？', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => useAppStore.getState().clearMessages() },
    ]);
  }, []);

  // 渲染：根据 isActivity 路由到不同组件
  const renderItem = useCallback(
    ({ item }: { item: ChatMessage }) => {
      if (item.isActivity) {
        return <ActivityMessage item={item} colors={colors} />;
      }
      return <MessageItem item={item} colors={colors} />;
    },
    [colors]
  );

  return (
    <ScreenContainer>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
        <TouchableOpacity
          style={[styles.modelChip, { backgroundColor: colors.background, borderColor: colors.border }]}
          onPress={() => router.push('/(tabs)/models')}
          accessible
          accessibilityRole="button"
          accessibilityLabel={`当前模型：${activeModel ? activeModel.name : '未加载模型'}，双击切换`}
        >
          <Text style={[styles.modelDot, { color: activeModel?.isLoaded ? colors.success : colors.muted }]}>
            {activeModel?.isLoaded ? '●' : '○'}
          </Text>
          <Text style={[styles.modelChipText, { color: colors.foreground }]} numberOfLines={1}>
            {activeModel ? activeModel.name : '点击加载模型'}
          </Text>
        </TouchableOpacity>

        <View style={styles.headerRight}>
          <View style={styles.toolChips}>
            {(
              [
                { key: 'WebSearch', label: '搜', icon: '🔍' },
                { key: 'Files', label: '文', icon: '📁' },
                { key: 'Media', label: '媒', icon: '🎬' },
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
                  accessibilityLabel={`${label}工具${enabled ? '已启用' : '已禁用'}，双击进入工具设置`}
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
              accessibilityLabel="清空对话记录"
            >
              <Text style={[styles.clearBtnText, { color: colors.muted }]}>清空</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Messages */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        {messages.length === 0 ? (
          <View style={styles.emptyState} accessible accessibilityLabel="欢迎使用离线 AI 助手，请先加载模型后开始对话">
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>离线 AI 助手</Text>
            <Text style={[styles.emptyDesc, { color: colors.muted }]}>
              所有推理在本地设备运行，无需网络。{'\n'}
              支持文件管理、多媒体处理和网络搜索工具。{'\n'}
              工作区：{workspaceDir || '加载中...'}
            </Text>
            {!activeModel?.isLoaded && (
              <TouchableOpacity
                style={[styles.loadModelBtn, { backgroundColor: colors.primary }]}
                onPress={() => router.push('/(tabs)/models')}
                accessible
                accessibilityRole="button"
                accessibilityLabel="前往加载模型"
              >
                <Text style={styles.loadModelBtnText}>📦 加载模型</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={scrollToBottom}
            // 关键：聊天流式输出时 list 经常变，但 contentContainerStyle 是固定 style 对象引用
            // removeClippedSubviews 关闭防止测量错误
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
            placeholder={activeModel?.isLoaded ? '输入消息...' : '请先加载模型'}
            placeholderTextColor={colors.muted}
            multiline
            maxLength={4000}
            editable={!isGenerating && !!activeModel?.isLoaded}
            returnKeyType="default"
            accessible
            accessibilityRole="none"
            accessibilityLabel="消息输入框"
            accessibilityHint={activeModel?.isLoaded ? '输入您的消息，然后点击发送' : '请先在模型页面加载一个 GGUF 模型'}
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
            accessibilityLabel={isGenerating ? '正在生成回复，请稍候' : '发送消息'}
            accessibilityHint="双击发送消息"
          >
            {isGenerating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.sendBtnText}>发送</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

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
  // Activity 行（轻量提示）
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
