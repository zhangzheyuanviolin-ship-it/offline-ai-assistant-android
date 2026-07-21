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
import { runInferenceOrchestrator } from '@/lib/services/inference-orchestrator';
import { AccessibilityChunkedText } from '@/components/accessibility-chunked-text';
import { executeTool, formatToolResultForModel, toolRequiresConfirmation } from '@/lib/services/tools-service';
import { ChatMessage, ToolCall, ToolLog } from '@/lib/types';
import { ToolConfirmationModal } from '@/components/tool-confirmation-modal';
import { router } from 'expo-router';

// ─── Parse thinking tags ─────────────────────────────────────────────────────

const BUILD20_CHAT_READY = true;

const BUILD41_ACCESSIBILITY_BOUNDARY = true;

interface ParsedContent { thinking: string; response: string; }
function parseThinkingTags(text: string): ParsedContent {
  const normalized = text.replace(/<\|[^|]+?\|>/g, '').trim();
  const complete = normalized.match(/<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i);
  if (complete) return { thinking: complete[1].trim(), response: normalized.replace(complete[0], '').trim() };
  const closing = normalized.match(/<\/(?:think|thinking)>/i);
  if (closing && closing.index !== undefined) {
    return { thinking: normalized.slice(0, closing.index).trim(), response: normalized.slice(closing.index + closing[0].length).trim() };
  }
  return { thinking: '', response: normalized };
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
              accessibilityLabel={`${showThinking ? '隐藏' : '展开'}思考过程`}
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

// ─── Chat Screen ─────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const colors = useColors();
  const [inputText, setInputText] = useState('');
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  const [resolveToolCall, setResolveToolCall] = useState<((result: string) => void) | null>(null);
  const flatListRef = useRef<FlatList>(null);

  // \u6d41\u5f0f\u8f93\u51fa\u7684\u7eaf\u672c\u5730\u72b6\u6001\uff08\u4e0d\u8d70 store\uff0c\u907f\u514d FlatList \u5168\u91cf\u91cd\u6e32\u67d3\uff09
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
    setStreamActivity('AI \u6b63\u5728\u601d\u8003...');

    try {
      const currentMessages = useAppStore.getState().messages;
      const currentParams = useAppStore.getState().inferenceParams;
      const currentTools = useAppStore.getState().toolsConfig;
      const ws = useAppStore.getState().workspaceDir;

      // \u8ba9 UI \u6709\u673a\u4f1a\u6e32\u67d3\u521d\u59cb\u72b6\u6001
      await new Promise((r) => setTimeout(r, 50));

      const finalResult = await runInferenceOrchestrator(
        text,
        currentMessages,
        currentTools,
        currentParams,
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
      // \u7ed3\u675f\u6d41\u5f0f\u8f93\u51fa
      setIsStreaming(false);
      setStreamActivity('');

      // \u4e00\u6b21\u6027\u5199\u5165 store\uff08\u4f9b\u6301\u4e45\u5316\uff09
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
      const errMsg = err instanceof Error ? err.message : '\u63a8\u7406\u5931\u8d25';
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
    ? [...messages, { id: '__streaming__', isStreaming: true, content: '', role: 'assistant', timestamp: Date.now(), _activity: streamActivity } as unknown as ChatMessage]
    : messages;

  const renderStreamingItem = useCallback(({ item }: { item: ChatMessage }) => {
    if ((item as any).id === '__streaming__') {
      return <StreamingMessage activityText={streamActivity} colors={colors} />;
    }
    return <MessageItem item={item} colors={colors} />;
  }, [colors, streamActivity]);

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