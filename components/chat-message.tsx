import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { ChatMessage as ChatMessageType } from '@/lib/types';
import { useColors } from '@/hooks/use-colors';

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const colors = useColors();
  const isUserMessage = message.role === 'user';

  return (
    <View
      className={`px-4 py-3 ${isUserMessage ? 'items-end' : 'items-start'}`}
      accessible={true}
      accessibilityLabel={`${isUserMessage ? 'You' : 'Assistant'}: ${message.content}`}
      accessibilityRole="text"
    >
      <View
        className={`max-w-xs rounded-lg px-4 py-2 ${
          isUserMessage
            ? 'bg-primary'
            : 'bg-surface border border-border'
        }`}
      >
        <Text
          className={`text-base leading-relaxed ${
            isUserMessage ? 'text-background' : 'text-foreground'
          }`}
        >
          {message.content}
        </Text>

        {/* 工具调用显示 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <View className="mt-2 pt-2 border-t border-border">
            {message.toolCalls.map((toolCall) => (
              <View key={toolCall.id} className="mt-1">
                <Text className={`text-xs font-semibold ${isUserMessage ? 'text-background' : 'text-muted'}`}>
                  Tool: {toolCall.toolName}
                </Text>
                <Text className={`text-xs ${isUserMessage ? 'text-background' : 'text-muted'}`}>
                  Status: {toolCall.status}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* 工具结果显示 */}
        {message.toolResults && message.toolResults.length > 0 && (
          <View className="mt-2 pt-2 border-t border-border">
            {message.toolResults.map((result, idx) => (
              <View key={idx} className="mt-1">
                <Text className={`text-xs font-semibold ${isUserMessage ? 'text-background' : result.success ? 'text-success' : 'text-error'}`}>
                  {result.toolName}: {result.success ? 'Success' : 'Failed'}
                </Text>
                {result.error && (
                  <Text className={`text-xs ${isUserMessage ? 'text-background' : 'text-error'}`}>
                    {result.error}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}
      </View>

      <Text className="text-xs text-muted mt-1">
        {new Date(message.timestamp).toLocaleTimeString()}
      </Text>
    </View>
  );
}
