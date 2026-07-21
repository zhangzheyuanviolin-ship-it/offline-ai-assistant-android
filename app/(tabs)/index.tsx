import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore, selectActiveModel } from '@/lib/store';
import {
  InferenceStreamSnapshot,
  runInferenceOrchestrator,
} from '@/lib/services/inference-orchestrator';
import {
  AccessibilityChunkedText,
  AccessibilityStreamingText,
} from '@/components/accessibility-chunked-text';
import {
  executeTool,
  formatToolResultForModel,
  toolRequiresConfirmation,
} from '@/lib/services/tools-service';
import { ChatMessage, ToolCall, ToolLog } from '@/lib/types';
import { ToolConfirmationModal } from '@/components/tool-confirmation-modal';
import { router } from 'expo-router';

interface ParsedContent {
  thinking: string;
  response: string;
}

function parseThinkingTags(text: string): ParsedContent {
  const normalized = text.replace(/<\|[^|]+?\|>/g, '').trim();
  const complete = normalized.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
  if (complete && complete.index !== undefined) {
    return {
      thinking: complete[1].trim(),
      response: `${normalized.slice(0, complete.index)}${normalized.slice(complete.index + complete[0].length)}`.trim(),
    };
  }
  const closing = normalized.match(/<\/(?:think|thinking)>/i);
  if (closing && closing.index !== undefined) {
    return {
      thinking: normalized.slice(0, closing.index).trim(),
      response: normalized.slice(closing.index + closing[0].length).trim(),
    };
  }
  return { thinking: '', response: normalized };
}

const MessageItem = memo(function MessageItem({
  item,
  colors,
}: {
  item: ChatMessage;
  colors: ReturnType<typeof useColors>;
}) {
  const isUser = item.role === 'user';
  const legacy = isUser ? { thinking: '', response: item.content } : parseThinkingTags(item.content);
  const thinking = isUser ? '' : (item.reasoning?.trim() || legacy.thinking);
  const response = isUser
    ? item.content
    : (legacy.response || (thinking ? '模型没有生成最终回答。' : item.content));
  const [showThinking, setShowThinking] = useState(false);

  return (
    <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]} accessible={false}>
      <View
        style={[
          styles.msgBubble,
          {
            backgroundColor: isUser ? colors.primary : colors.surface,
            borderColor: isUser ? colors.primary : colors.border,
          },
        ]}
        accessible={false}
      >
        {!isUser && thinking.length > 0 && (
          <View style={styles.thinkingContainer} accessible={false}>
            <TouchableOpacity
              onPress={() => setShowThinking((value) => !value)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${showThinking ? '隐藏' : '展开'}思考过程，共 ${thinking.length} 个字符`}
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

const StreamingMessage = memo(function StreamingMessage({
  snapshot,
  activityText,
  colors,
}: {
  snapshot: InferenceStreamSnapshot;
  activityText: string;
  colors: ReturnType<typeof useColors>;
}) {
  const [showThinking, setShowThinking] = useState(true);
  const reasoningAppeared = useRef(false);

  useEffect(() => {
    if (snapshot.reasoning.length > 0 && !reasoningAppeared.current) {
      reasoningAppeared.current = true;
      setShowThinking(true);
    }
  }, [snapshot.reasoning.length]);

  const status = activityText || (
    snapshot.phase === 'answering'
      ? 'AI 正在输出最终回答...'
      : snapshot.reasoning
        ? 'AI 正在输出思考内容...'
        : 'AI 正在思考...'
  );

  return (
    <View style={[styles.msgRow, styles.msgRowAssistant]} accessible={false}>
      <View
        style={[styles.msgBubble, { backgroundColor: colors.surface, borderColor: colors.border }]}
        accessible={false}
      >
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

        {snapshot.reasoning.length > 0 && (
          <View style={styles.thinkingContainer} accessible={false}>
            <TouchableOpacity
              onPress={() => setShowThinking((value) => !value)}
              accessible
              accessibilityRole="button"
              accessibilityLabel={`${showThinking ? '隐藏' : '展开'}正在生成的思考过程，当前 ${snapshot.reasoning.length} 个字符`}
              accessibilityState={{ expanded: showThinking }}
              style={styles.thinkingToggle}
            >
              <Text style={[styles.thinkingToggleText, { color: colors.muted }]}> 
                {showThinking ? '▼ 正在生成思考过程' : '▶ 正在生成思考过程'}
              </Text>
            </TouchableOpacity>
            {showThinking && (
              <View style={[styles.thinkingContent, { borderColor: colors.border }]} accessible={false}>
                <AccessibilityStreamingText
                  text={snapshot.reasoning}
                  label="正在生成的思考过程"
                  style={[styles.thinkingText, { color: colors.muted }]}
                />
              </View>
            )}
          </View>
        )}

        {snapshot.content.length > 0 && (
          <View style={styles.streamingAnswer} accessible={false}>
            <Text
              style={[styles.streamingHeading, { color: colors.muted }]}
              accessible
              accessibilityRole="header"
              accessibilityLabel="正在生成最终回答"
            >
              最终回答
            </Text>
            <AccessibilityStreamingText
              text={snapshot.content}
              label="正在生成的最终回答"
              style={[styles.msgText, { color: colors.foreground }]}
            />
          </View>
        )}
      </View>
    </View>
  );
});

const EMPTY_STREAM: InferenceStreamSnapshot = {
  content: '',
  reasoning: '',
  phase: 'thinking',
  toolSteps: 0,
};

export default function ChatScreen() {
  const colors = useColors();
  const [inputText, setInputText] = useState('');
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  const [resolveToolCall, setResolveToolCall] = useState<((result: string) => void) | null>(null);
  const [streamActivity, setStreamActivity] = useState('');
  const [streamSnapshot, setStreamSnapshot] = useState<InferenceStreamSnapshot>(EMPTY_STREAM);
  const [isStreaming, setIsStreaming] = useState(false);
  const [screenReaderEnabled, setScreenReaderEnabled] = useState(false);
  const flatListRef = useRef<FlatList<ChatMessage>>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamSnapshotRef = useRef<InferenceStreamSnapshot>(EMPTY_STREAM);

  const {
    messages,
    isGenerating,
    toolsConfig,
    workspaceDir,
    addMessage,
    addLog,
    setGenerating,
    setError,
    setWorkspaceDir,
  } = useAppStore();

  const activeModel = useAppStore(selectActiveModel);

  useEffect(() => {
    useAppStore.getState().loadModelsFromStorage().then(() => {
      useAppStore.getState().syncModelLoadedState();
    });
  }, []);

  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReaderEnabled).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReaderEnabled);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') useAppStore.getState().syncModelLoadedState();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!workspaceDir) {
      try {
        const { FileSystem } = require('expo-file-system/legacy');
        const base = FileSystem.documentDirectory || 'file:///data/data/space.manus.offline.ai.assistant.t20260106034740/files/';
        const basePath = base.startsWith('file://') ? base.slice('file://'.length) : base;
        setWorkspaceDir(`${basePath.replace(/\/+$/, '')}/workspace`);
      } catch {
        setWorkspaceDir('/data/data/space.manus.offline.ai.assistant.t20260106034740/files/workspace');
      }
    }
  }, [workspaceDir, setWorkspaceDir]);

  const scheduleScrollToBottom = useCallback((animated = false) => {
    if (scrollTimerRef.current) return;
    scrollTimerRef.current = setTimeout(() => {
      scrollTimerRef.current = null;
      flatListRef.current?.scrollToEnd({ animated });
    }, 180);
  }, []);

  useEffect(() => {
    if (messages.length > 0 && !isStreaming) scheduleScrollToBottom(false);
  }, [messages.length, isStreaming, scheduleScrollToBottom]);

  useEffect(() => () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
  }, []);

  const handleToolCall = useCallback(
    (toolCall: ToolCall): Promise<string> => new Promise((resolve) => {
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
            resolve(formatToolResultForModel(result));
          })
          .catch((err: Error) => resolve(`执行失败: ${err.message}`));
      } else {
        setPendingToolCall(toolCall);
        setResolveToolCall(() => resolve);
      }
    }),
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
    resolveToolCall(formatToolResultForModel(result));
    setResolveToolCall(null);
  }, [pendingToolCall, resolveToolCall, toolsConfig, addLog]);

  const handleCancelTool = useCallback(() => {
    if (!pendingToolCall || !resolveToolCall) return;
    setPendingToolCall(null);
    resolveToolCall('用户取消了此操作');
    setResolveToolCall(null);
  }, [pendingToolCall, resolveToolCall]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isGenerating) return;

    if (!activeModel?.isLoaded) {
      Alert.alert(
        '未加载模型',
        '请先在“模型”页面加载一个 GGUF 模型',
        [{ text: '去加载', onPress: () => router.push('/(tabs)/models') }, { text: '取消' }]
      );
      return;
    }

    setInputText('');
    setGenerating(true);
    setError(null);

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}_u`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    addMessage(userMsg);

    streamSnapshotRef.current = EMPTY_STREAM;
    setStreamSnapshot(EMPTY_STREAM);
    setIsStreaming(true);
    setStreamActivity('AI 正在思考...');

    try {
      const currentMessages = useAppStore.getState().messages;
      const currentParams = useAppStore.getState().inferenceParams;
      const currentTools = useAppStore.getState().toolsConfig;
      await new Promise((resolve) => setTimeout(resolve, 40));

      const finalResult = await runInferenceOrchestrator(
        text,
        currentMessages,
        currentTools,
        currentParams,
        handleToolCall,
        (_kind, activity) => setStreamActivity(activity),
        (snapshot) => {
          streamSnapshotRef.current = snapshot;
          setStreamSnapshot(snapshot);
        }
      );

      setIsStreaming(false);
      setStreamActivity('');
      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content: finalResult.content,
        reasoning: finalResult.reasoning || undefined,
        timestamp: Date.now(),
      };
      addMessage(assistantMsg);
    } catch (err) {
      setIsStreaming(false);
      const errMsg = err instanceof Error ? err.message : '推理失败';
      setStreamActivity('');
      const partial = streamSnapshotRef.current;
      const content = partial.content
        ? `${partial.content}\n\n⚠️ 生成被中断：${errMsg}`
        : `❌ ${errMsg}`;
      addMessage({
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        content,
        reasoning: partial.reasoning || undefined,
        timestamp: Date.now(),
      });
      setError(errMsg);
    } finally {
      setGenerating(false);
      streamSnapshotRef.current = EMPTY_STREAM;
      setStreamSnapshot(EMPTY_STREAM);
    }
  }, [
    inputText,
    isGenerating,
    activeModel,
    addMessage,
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

  const listData: ChatMessage[] = isStreaming
    ? [
        ...messages,
        {
          id: '__streaming__',
          isStreaming: true,
          content: '',
          role: 'assistant',
          timestamp: Date.now(),
        },
      ]
    : messages;

  const renderItem = useCallback(({ item }: { item: ChatMessage }) => {
    if (item.id === '__streaming__') {
      return (
        <StreamingMessage
          snapshot={streamSnapshot}
          activityText={streamActivity}
          colors={colors}
        />
      );
    }
    return <MessageItem item={item} colors={colors} />;
  }, [colors, streamActivity, streamSnapshot]);

  return (
    <ScreenContainer>
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
            {([
              { key: 'WebSearch', label: '搜索', icon: '🔍' },
              { key: 'Files', label: '文件', icon: '📁' },
              { key: 'Media', label: '媒体', icon: '🎬' },
            ] as const).map(({ key, label, icon }) => {
              const enabled = toolsConfig[key].enabled;
              return (
                <TouchableOpacity
                  key={key}
                  style={[
                    styles.toolChip,
                    {
                      backgroundColor: enabled ? `${colors.primary}22` : colors.surface,
                      borderColor: enabled ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => router.push('/(tabs)/tools-settings')}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`${label}工具${enabled ? '已启用' : '已禁用'}，双击进入工具设置`}
                >
                  <Text style={[styles.toolChipText, { color: enabled ? colors.primary : colors.muted }]}>{icon}</Text>
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

      <View style={styles.flex}>
        {listData.length === 0 ? (
          <View style={styles.emptyState} accessible accessibilityLabel="欢迎使用离线 AI 助手，请先加载模型后开始对话">
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>离线 AI 助手</Text>
            <Text style={[styles.emptyDesc, { color: colors.muted }]}> 
              所有推理在本地设备运行。{`\n`}
              支持文件、媒体和网络搜索工具。{`\n`}
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
            data={listData}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.messageList}
            onContentSizeChange={() => {
              // 屏幕阅读器开启时不在流式生成期间抢夺滚动和焦点。
              if (isStreaming && screenReaderEnabled) return;
              scheduleScrollToBottom(false);
            }}
            removeClippedSubviews={false}
            accessible={false}
          />
        )}

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
            accessibilityLabel="消息输入框"
            accessibilityHint={activeModel?.isLoaded ? '输入消息，然后点击发送' : '请先在模型页面加载一个 GGUF 模型'}
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
            accessibilityLabel={isGenerating ? '正在生成回复' : '发送消息'}
            accessibilityHint="双击发送消息"
          >
            {isGenerating
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.sendBtnText}>发送</Text>}
          </TouchableOpacity>
        </View>
      </View>

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
  clearBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
  clearBtnText: { fontSize: 12, fontWeight: '500' },
  messageList: { padding: 12, gap: 8, paddingBottom: 16 },
  msgRow: { marginBottom: 4 },
  msgRowUser: { alignItems: 'flex-end' },
  msgRowAssistant: { alignItems: 'flex-start' },
  msgBubble: {
    maxWidth: '88%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: 'center',
  },
  msgText: { fontSize: 15, lineHeight: 22 },
  msgTime: { fontSize: 11, marginTop: 3, marginHorizontal: 4 },
  typingIndicator: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  typingText: { fontSize: 13 },
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
  thinkingText: { fontSize: 13, lineHeight: 19, fontStyle: 'italic' },
  streamingAnswer: { marginTop: 4 },
  streamingHeading: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 },
  emptyTitle: { fontSize: 24, fontWeight: '700' },
  emptyDesc: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  loadModelBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24, marginTop: 8 },
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
