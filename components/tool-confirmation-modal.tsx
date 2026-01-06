import React from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  AccessibilityInfo,
  findNodeHandle,
} from 'react-native';
import { ToolCall } from '@/lib/types';
import { useColors } from '@/hooks/use-colors';

interface ToolConfirmationModalProps {
  visible: boolean;
  toolCall: ToolCall | null;
  onConfirm: () => void;
  onCancel: () => void;
  isExecuting?: boolean;
}

export function ToolConfirmationModal({
  visible,
  toolCall,
  onConfirm,
  onCancel,
  isExecuting = false,
}: ToolConfirmationModalProps) {
  const colors = useColors();

  if (!toolCall) return null;

  const handleConfirm = () => {
    onConfirm();
  };

  const handleCancel = () => {
    onCancel();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
      accessible={true}
      accessibilityViewIsModal={true}
    >
      <View
        className="flex-1 bg-black/50 justify-center items-center px-4"
        accessible={true}
        accessibilityRole="alert"
        accessibilityLabel="Tool confirmation dialog"
      >
        <View
          className="bg-surface rounded-2xl p-6 w-full max-w-sm shadow-lg"
          accessible={true}
        >
          {/* 标题 */}
          <Text
            className="text-xl font-bold text-foreground mb-4"
            accessible={true}
            accessibilityRole="header"
            accessibilityLabel={`Tool confirmation: ${toolCall.toolName}`}
          >
            Tool Confirmation
          </Text>

          {/* 工具名称 */}
          <View className="mb-4 p-3 bg-background rounded-lg">
            <Text className="text-sm text-muted mb-1">Tool Name:</Text>
            <Text
              className="text-base font-semibold text-foreground"
              accessible={true}
              accessibilityLabel={`Tool: ${toolCall.toolName}`}
            >
              {toolCall.toolName}
            </Text>
          </View>

          {/* 工具类别 */}
          <View className="mb-4 p-3 bg-background rounded-lg">
            <Text className="text-sm text-muted mb-1">Category:</Text>
            <Text
              className="text-base font-semibold text-foreground"
              accessible={true}
              accessibilityLabel={`Category: ${toolCall.toolCategory}`}
            >
              {toolCall.toolCategory}
            </Text>
          </View>

          {/* 参数 */}
          {Object.keys(toolCall.parameters).length > 0 && (
            <View className="mb-4 p-3 bg-background rounded-lg">
              <Text className="text-sm text-muted mb-2">Parameters:</Text>
              <ScrollView className="max-h-32">
                {Object.entries(toolCall.parameters).map(([key, value]) => (
                  <View key={key} className="mb-1">
                    <Text className="text-xs text-muted">{key}:</Text>
                    <Text
                      className="text-sm text-foreground font-mono"
                      accessible={true}
                      accessibilityLabel={`Parameter ${key}: ${String(value)}`}
                    >
                      {typeof value === 'string' ? value : JSON.stringify(value)}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

          {/* 警告信息 */}
          <View className="mb-6 p-3 bg-warning/10 rounded-lg border border-warning">
            <Text
              className="text-sm text-warning font-semibold"
              accessible={true}
              accessibilityLabel="Warning: Please review the tool action before confirming"
            >
              ⚠ Please review the tool action before confirming
            </Text>
          </View>

          {/* 按钮 */}
          <View className="flex-row gap-3">
            <TouchableOpacity
              onPress={handleCancel}
              disabled={isExecuting}
              className={`flex-1 py-3 rounded-lg border-2 border-border ${
                isExecuting ? 'opacity-50' : ''
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              accessibilityHint="Cancel the tool execution"
            >
              <Text className="text-center text-foreground font-semibold">Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleConfirm}
              disabled={isExecuting}
              className={`flex-1 py-3 rounded-lg bg-primary ${
                isExecuting ? 'opacity-50' : ''
              }`}
              accessible={true}
              accessibilityRole="button"
              accessibilityLabel="Confirm"
              accessibilityHint="Confirm and execute the tool"
            >
              <Text className="text-center text-background font-semibold">
                {isExecuting ? 'Executing...' : 'Confirm'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
