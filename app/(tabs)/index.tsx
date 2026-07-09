import React, { useCallback, useEffect, useRef, useState } from 'react';
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
 */
async function runInference(
  userText: string,
  history: ChatMessage[],
  toolsConfig: ReturnType<typeof useAppStore.getState>['toolsConfig'],
  inferenceParams: ReturnType<typeof useAppStore.getState>['inferenceParams'],
  onToken: (token: string) => void,
  onToolCall: (call: ToolCall) => Promise<string>
): Promise<string> {
  const ctx = getActiveContext();
  if (!ctx) throw new Error('没有已加载的模型，请先在"模型"页面加载一个 GGUF 模型');

  // 构建极简系统提示（工具描述 < 200 token）
  const toolPrompt = buildCompactSystemPrompt(toolsConfig);
  const systemContent = `你是一个离线 AI 助手，运行在用户手机上。简洁回答，必要时调用工具。${toolPrompt}`;

  // 构建消息历史（仅保留最近 10 轮，节省上下文）
  const recentHistory = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-20);

  const msgs: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemContent },
    ...recentHistory.map((m) => ({ role: m.role as string, content: m.content })),
    { role: 'user', content: userText },
  ];

  let fullResponse = '';
  let toolCallRound = 0;
  const MAX_TOOL_ROUNDS = 3; // 最多 3 轮工具调用，防止无限循环

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
        stop: [...inferenceParams.stop, '{"t":', '```json'],
      },
      (data: { token: string }) => {
        roundText += data.token;
        // 只在第一轮流式输出给用户
        if (toolCallRound === 0) {
          fullResponse += data.token;
          onToken(data.token);
        }
      }
    );

    if (toolCallRound > 0) {
      fullResponse += roundText;
    }

    // 解析工具调用
    const toolCalls = parseToolCalls(roundText);
    if (toolCalls.length === 0) break; // 没有工具调用，结束

    toolCallRound++;
    if (toolCallRound > MAX_TOOL_ROUNDS) break;

    // 执行工具调用
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

    // 将工具结果注入到消息历史，继续推理
    const toolResultContent = toolResults.join('\n');
    msgs.push({ role: 'assistant', content: roundText });
    msgs.push({ role: 'user', content: `工具执行完成：\n${toolResultContent}\n\n请根据以上结果继续回答。` });

    // 通知用户工具正在执行
    const toolNotice = `\n\n[正在执行工具: ${toolCalls.map((t) => t.toolName).join(', ')}...]\n`;
    fullResponse += toolNotice;
    onToken(toolNotice);
  }

  return fullResponse;
}

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
    addMessage,
    updateMessage,
    addLog,
    setGenerating,
    setError,
  } = useAppStore();

  const activeModel = useAppStore(selectActiveModel);

  // 滚动到底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
  }, []);

  useEffect(() => {
    if (messages.length > 0) scrollToBottom();
  }, [messages, scrollToBottom]);

  // 工具调用处理
  const handleToolCall = useCallback(
    (toolCall: ToolCall): Promise<string> => {
      return new Promise((resolve) => {
        const needsConfirm = toolRequiresConfirmation(toolCall.toolName, toolsConfig);
        if (!needsConfirm) {
          const startMs = Date.now();
          executeTool(toolCall.toolName, toolCall.toolCategory, toolCall.parameters, toolsConfig)
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
    const result = await executeTool(
      pendingToolCall.toolName,
      pendingToolCall.toolCategory,
      pendingToolCall.parameters,
      toolsConfig
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

    try {
      const finalText = await runInference(
        text,
        messages,
        toolsConfig,
        inferenceParams,
        (token) => {
          updateMessage(assistantMsgId, {
            content: (messages.find((m) => m.id === assistantMsgId)?.content ?? '') + token,
          });
        },
        handleToolCall
      );

      updateMessage(assistantMsgId, { content: finalText, isStreaming: false });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '推理失败';
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
    addLog,
    setGenerating,
    setError,
    handleToolCall,
  ]);

  const handleClearChat = useCallback(() => {
    Alert.alert('清空对话', '确定要清空所有对话记录吗？', [
      { text: '取消', style: 'cancel' },
      { text: '清空', style: 'destructive', onPress: () => useAppStore.getState().clearMessages() },
    ]);
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => {
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
              工具调用格式已针对小模型优化。
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
            renderItem={renderMessage}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={scrollToBottom}
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
});
