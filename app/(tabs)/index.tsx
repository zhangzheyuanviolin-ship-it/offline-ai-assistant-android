import React, { useEffect, useState, useRef } from 'react';
import {
  ScrollView,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useAppStore } from '@/lib/store';
import { useColors } from '@/hooks/use-colors';
import { ChatMessage } from '@/components/chat-message';
import { ToolConfirmationModal } from '@/components/tool-confirmation-modal';
import { initializeModelsDirectory } from '@/lib/services/model-service';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

/**
 * 主聊天屏幕
 */
export default function HomeScreen() {
  const colors = useColors();
  const isFocused = useIsFocused();
  
  // 状态
  const [messageText, setMessageText] = useState('');
  const [showToolConfirmation, setShowToolConfirmation] = useState(false);
  const [selectedToolCall, setSelectedToolCall] = useState<any>(null);
  const scrollViewRef = useRef<ScrollView>(null);

  // Store
  const {
    currentModel,
    chatMessages,
    isInferencing,
    toolsConfig,
    addChatMessage,
  } = useAppStore();

  // 初始化
  useEffect(() => {
    const init = async () => {
      try {
        await initializeModelsDirectory();
      } catch (error) {
        console.error('Failed to initialize:', error);
      }
    };
    init();
  }, []);

  // 滚动到底部
  useEffect(() => {
    if (chatMessages.length > 0) {
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [chatMessages]);

  // 发送消息
  const handleSendMessage = () => {
    if (!messageText.trim()) return;
    if (!currentModel) {
      alert('Please select a model first');
      return;
    }

    const userMessage = {
      id: `msg_${Date.now()}`,
      role: 'user' as const,
      content: messageText.trim(),
      timestamp: Date.now(),
    };

    addChatMessage(userMessage);
    setMessageText('');

    // TODO: 调用推理引擎
    // 这里将集成实际的 llama.cpp 推理
  };

  // 导入模型
  const handleImportModel = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/*',
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        router.push({
          pathname: '/(tabs)/models',
          params: { importPath: result.assets[0].uri },
        });
      }
    } catch (error) {
      console.error('Failed to pick document:', error);
    }
  };

  // 打开工具设置
  const handleOpenToolSettings = () => {
    router.push('/tools-settings');
  };

  // 打开日志
  const handleOpenLogs = () => {
    router.push('/logs');
  };

  // 打开模型管理
  const handleOpenModels = () => {
    router.push('/models');
  };

  return (
    <ScreenContainer className="flex-1 bg-background" edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        {/* 顶部控制栏 */}
        <View
          className="bg-surface border-b border-border px-4 py-3"
          accessible={true}
          accessibilityRole="toolbar"
          accessibilityLabel="Chat controls toolbar"
        >
          {/* 模型选择 */}
          <TouchableOpacity
            onPress={handleOpenModels}
            className="mb-3 p-2 bg-background rounded-lg border border-border"
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel={`Current model: ${currentModel?.name || 'No model selected'}`}
            accessibilityHint="Tap to select or import a model"
          >
            <Text className="text-sm font-semibold text-foreground">
              📦 {currentModel?.name || 'No Model'}
            </Text>
          </TouchableOpacity>

          {/* 工具开关 */}
          <View className="flex-row gap-2 mb-3">
            <TouchableOpacity
              onPress={handleOpenToolSettings}
              className={`flex-1 p-2 rounded-lg border ${
                toolsConfig.WebSearch.enabled
                  ? 'bg-primary border-primary'
                  : 'bg-background border-border'
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={`Web Search: ${toolsConfig.WebSearch.enabled ? 'enabled' : 'disabled'}`}
              accessibilityHint="Tap to toggle web search tool"
            >
              <Text
                className={`text-center text-xs font-semibold ${
                  toolsConfig.WebSearch.enabled ? 'text-background' : 'text-foreground'
                }`}
              >
                🔍 Search
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleOpenToolSettings}
              className={`flex-1 p-2 rounded-lg border ${
                toolsConfig.Files.enabled
                  ? 'bg-primary border-primary'
                  : 'bg-background border-border'
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={`Files: ${toolsConfig.Files.enabled ? 'enabled' : 'disabled'}`}
              accessibilityHint="Tap to toggle files tool"
            >
              <Text
                className={`text-center text-xs font-semibold ${
                  toolsConfig.Files.enabled ? 'text-background' : 'text-foreground'
                }`}
              >
                📁 Files
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleOpenToolSettings}
              className={`flex-1 p-2 rounded-lg border ${
                toolsConfig.Media.enabled
                  ? 'bg-primary border-primary'
                  : 'bg-background border-border'
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel={`Media: ${toolsConfig.Media.enabled ? 'enabled' : 'disabled'}`}
              accessibilityHint="Tap to toggle media tool"
            >
              <Text
                className={`text-center text-xs font-semibold ${
                  toolsConfig.Media.enabled ? 'text-background' : 'text-foreground'
                }`}
              >
                🎬 Media
              </Text>
            </TouchableOpacity>
          </View>

          {/* 日志按钮 */}
          <TouchableOpacity
            onPress={handleOpenLogs}
            className="p-2 bg-background rounded-lg border border-border"
            accessible={true}
            accessibilityRole="button"
            accessibilityLabel="View tool logs"
            accessibilityHint="Tap to view recent tool execution logs"
          >
            <Text className="text-sm font-semibold text-foreground">📋 Logs</Text>
          </TouchableOpacity>
        </View>

        {/* 聊天消息列表 */}
        <ScrollView
          ref={scrollViewRef}
          className="flex-1 bg-background"
          contentContainerStyle={{ flexGrow: 1 }}
          accessible={true}
          accessibilityRole="list"
          accessibilityLabel="Chat messages"
        >
          {chatMessages.length === 0 ? (
            <View className="flex-1 items-center justify-center px-4">
              <Text className="text-center text-lg font-semibold text-foreground mb-2">
                Welcome to Offline AI Assistant
              </Text>
              <Text className="text-center text-sm text-muted mb-4">
                Select a model and start chatting. Your AI runs locally on your device.
              </Text>
              <TouchableOpacity
                onPress={handleImportModel}
                className="bg-primary px-6 py-3 rounded-lg"
                accessible={true}
                accessibilityRole="button"
                accessibilityLabel="Import model"
              >
                <Text className="text-background font-semibold">📥 Import Model</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View className="py-4">
              {chatMessages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              {isInferencing && (
                <View className="px-4 py-3 items-start">
                  <View className="flex-row items-center gap-2">
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text className="text-sm text-muted">AI is thinking...</Text>
                  </View>
                </View>
              )}
            </View>
          )}
        </ScrollView>

        {/* 消息输入框 */}
        <View
          className="bg-surface border-t border-border px-4 py-3 gap-2"
          accessible={true}
          accessibilityRole="toolbar"
          accessibilityLabel="Message input area"
        >
          <View className="flex-row gap-2 items-end">
            <TextInput
              value={messageText}
              onChangeText={setMessageText}
              placeholder="Type your message..."
              placeholderTextColor={colors.muted}
              className="flex-1 bg-background border border-border rounded-lg px-4 py-2 text-foreground"
              multiline
              maxLength={1000}
              editable={!isInferencing && !!currentModel}
              accessible={true}
              accessibilityRole="search"
              accessibilityLabel="Message input"
              accessibilityHint="Enter your message to chat with the AI"
            />
            <TouchableOpacity
              onPress={handleSendMessage}
              disabled={isInferencing || !currentModel || !messageText.trim()}
              className={`bg-primary px-4 py-2 rounded-lg ${
                isInferencing || !currentModel || !messageText.trim() ? 'opacity-50' : ''
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              accessibilityHint="Send the message to the AI"
            >
              <Text className="text-background font-semibold">Send</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* 工具确认弹窗 */}
      <ToolConfirmationModal
        visible={showToolConfirmation}
        toolCall={selectedToolCall}
        onConfirm={() => {
          // TODO: 执行工具
          setShowToolConfirmation(false);
        }}
        onCancel={() => {
          setShowToolConfirmation(false);
        }}
      />
    </ScreenContainer>
  );
}
