import React from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useAppStore } from '@/lib/store';
import { useColors } from '@/hooks/use-colors';

/**
 * 日志查看屏幕
 */
export default function LogsScreen() {
  const colors = useColors();
  const { toolLogs, clearToolLogs, getRecentToolLogs } = useAppStore();

  const recentLogs = getRecentToolLogs(50);

  const handleClearLogs = () => {
    Alert.alert(
      'Clear Logs',
      'Are you sure you want to clear all logs?',
      [
        { text: 'Cancel', onPress: () => {} },
        {
          text: 'Clear',
          onPress: () => {
            clearToolLogs();
            Alert.alert('Success', 'Logs cleared');
          },
          style: 'destructive',
        },
      ]
    );
  };

  return (
    <ScreenContainer className="flex-1 bg-background">
      {/* 标题 */}
      <View className="px-4 py-4 border-b border-border flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="text-2xl font-bold text-foreground mb-2">📋 Tool Logs</Text>
          <Text className="text-sm text-muted">
            Recent tool execution history (last 50 entries)
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleClearLogs}
          disabled={recentLogs.length === 0}
          className={`px-3 py-2 rounded-lg ${
            recentLogs.length === 0
              ? 'bg-border opacity-50'
              : 'bg-error/10 border border-error'
          }`}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Clear all logs"
        >
          <Text className={`text-xs font-semibold ${
            recentLogs.length === 0 ? 'text-muted' : 'text-error'
          }`}>
            Clear
          </Text>
        </TouchableOpacity>
      </View>

      {/* 日志列表 */}
      {recentLogs.length === 0 ? (
        <View className="flex-1 items-center justify-center px-4">
          <Text className="text-center text-lg font-semibold text-foreground mb-2">
            No Logs Yet
          </Text>
          <Text className="text-center text-sm text-muted">
            Tool execution logs will appear here
          </Text>
        </View>
      ) : (
        <FlatList
          data={recentLogs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          renderItem={({ item }) => (
            <View
              className={`rounded-lg p-4 border ${
                item.result.success
                  ? 'bg-success/10 border-success'
                  : 'bg-error/10 border-error'
              }`}
              accessible={true}
              accessibilityRole="list"
              accessibilityLabel={`Tool log: ${item.toolName}`}
            >
              {/* 工具名称和状态 */}
              <View className="flex-row items-center justify-between mb-2">
                <Text className="text-lg font-bold text-foreground">
                  {item.toolName}
                </Text>
                <Text
                  className={`text-xs font-semibold px-2 py-1 rounded ${
                    item.result.success
                      ? 'bg-success/20 text-success'
                      : 'bg-error/20 text-error'
                  }`}
                  accessible={true}
                  accessibilityLabel={`Status: ${item.result.success ? 'Success' : 'Failed'}`}
                >
                  {item.result.success ? '✓ Success' : '✗ Failed'}
                </Text>
              </View>

              {/* 工具类别 */}
              <Text className="text-sm text-muted mb-2">
                Category: {item.toolCategory}
              </Text>

              {/* 时间戳 */}
              <Text className="text-xs text-muted mb-3">
                Time: {new Date(item.timestamp).toLocaleString()}
              </Text>

              {/* 执行时间 */}
              <Text className="text-xs text-muted mb-3">
                Duration: {item.executionTime}ms
              </Text>

              {/* 参数 */}
              {Object.keys(item.parameters).length > 0 && (
                <View className="mb-3 p-2 bg-background rounded">
                  <Text className="text-xs font-semibold text-muted mb-1">Parameters:</Text>
                  {Object.entries(item.parameters).map(([key, value]) => (
                    <Text
                      key={key}
                      className="text-xs text-muted font-mono"
                      accessible={true}
                      accessibilityLabel={`Parameter ${key}: ${String(value)}`}
                    >
                      {key}: {typeof value === 'string' ? value : JSON.stringify(value)}
                    </Text>
                  ))}
                </View>
              )}

              {/* 结果 */}
              <View className="p-2 bg-background rounded">
                <Text className="text-xs font-semibold text-muted mb-1">Result:</Text>
                {item.result.error ? (
                  <Text
                    className="text-xs text-error font-mono"
                    accessible={true}
                    accessibilityLabel={`Error: ${item.result.error}`}
                  >
                    Error: {item.result.error}
                  </Text>
                ) : (
                  <Text
                    className="text-xs text-success font-mono"
                    accessible={true}
                    accessibilityLabel={`Result: ${JSON.stringify(item.result.data)}`}
                  >
                    {JSON.stringify(item.result.data, null, 2)}
                  </Text>
                )}
              </View>

              {/* 用户确认状态 */}
              <View className="mt-3 pt-3 border-t border-border">
                <Text className="text-xs text-muted">
                  User Confirmed: {item.userConfirmed ? '✓ Yes' : '✗ No'}
                </Text>
              </View>
            </View>
          )}
        />
      )}
    </ScreenContainer>
  );
}
