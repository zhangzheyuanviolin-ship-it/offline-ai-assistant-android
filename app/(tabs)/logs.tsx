import React from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore } from '@/lib/store';
import { ToolLog } from '@/lib/types';

export default function LogsScreen() {
  const colors = useColors();
  const { logs, clearLogs } = useAppStore();

  const handleClear = () => {
    Alert.alert('清除日志', '确定要清除所有工具调用日志吗？', [
      { text: '取消', style: 'cancel' },
      { text: '清除', style: 'destructive', onPress: clearLogs },
    ]);
  };

  const renderLog = ({ item }: { item: ToolLog }) => {
    const isSuccess = item.result.success;
    const time = new Date(item.timestamp).toLocaleTimeString('zh-CN');
    const date = new Date(item.timestamp).toLocaleDateString('zh-CN');

    return (
      <View
        style={[
          styles.logCard,
          {
            backgroundColor: colors.surface,
            borderColor: isSuccess ? colors.success : colors.error,
          },
        ]}
        accessible
        accessibilityLabel={`工具日志：${item.toolName}，${isSuccess ? '成功' : '失败'}，${date} ${time}，耗时 ${item.executionTimeMs} 毫秒`}
      >
        <View style={styles.logHeader}>
          <View style={styles.logTitleRow}>
            <Text style={[styles.logToolName, { color: colors.foreground }]}>
              {item.toolName}
            </Text>
            <View
              style={[
                styles.statusBadge,
                { backgroundColor: isSuccess ? colors.success + '33' : colors.error + '33' },
              ]}
            >
              <Text
                style={[
                  styles.statusText,
                  { color: isSuccess ? colors.success : colors.error },
                ]}
              >
                {isSuccess ? '✓ 成功' : '✗ 失败'}
              </Text>
            </View>
          </View>
          <Text style={[styles.logMeta, { color: colors.muted }]}>
            {item.toolCategory} · {date} {time} · {item.executionTimeMs}ms
            {item.userConfirmed ? ' · 已确认' : ''}
          </Text>
        </View>

        {Object.keys(item.parameters).length > 0 && (
          <View style={[styles.codeBlock, { backgroundColor: colors.background }]}>
            <Text style={[styles.codeLabel, { color: colors.muted }]}>参数</Text>
            <Text
              style={[styles.codeText, { color: colors.foreground }]}
              accessibilityLabel={`参数：${JSON.stringify(item.parameters)}`}
            >
              {JSON.stringify(item.parameters, null, 2)}
            </Text>
          </View>
        )}

        <View style={[styles.codeBlock, { backgroundColor: colors.background }]}>
          <Text style={[styles.codeLabel, { color: colors.muted }]}>结果</Text>
          {item.result.error ? (
            <Text
              style={[styles.codeText, { color: colors.error }]}
              accessibilityLabel={`错误：${item.result.error}`}
            >
              {item.result.error}
            </Text>
          ) : (
            <Text
              style={[styles.codeText, { color: colors.success }]}
              accessibilityLabel={`结果：${JSON.stringify(item.result.data)}`}
            >
              {JSON.stringify(item.result.data, null, 2)}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View>
          <Text
            style={[styles.headerTitle, { color: colors.foreground }]}
            accessibilityRole="header"
          >
            工具调用日志
          </Text>
          <Text style={[styles.headerSub, { color: colors.muted }]}>
            最近 {logs.length} 条记录（最多保留 50 条）
          </Text>
        </View>
        {logs.length > 0 && (
          <TouchableOpacity
            style={[styles.clearBtn, { borderColor: colors.error }]}
            onPress={handleClear}
            accessible
            accessibilityRole="button"
            accessibilityLabel="清除所有日志"
            accessibilityHint="双击清除所有工具调用日志"
          >
            <Text style={[styles.clearBtnText, { color: colors.error }]}>清除</Text>
          </TouchableOpacity>
        )}
      </View>

      {logs.length === 0 ? (
        <View
          style={styles.emptyState}
          accessible
          accessibilityLabel="暂无日志，工具调用记录将显示在此处"
        >
          <Text style={[styles.emptyIcon, { color: colors.muted }]}>📋</Text>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>暂无日志</Text>
          <Text style={[styles.emptyDesc, { color: colors.muted }]}>
            AI 调用工具后，执行记录将显示在此处
          </Text>
        </View>
      ) : (
        <FlatList
          data={[...logs].reverse()}
          keyExtractor={(item) => item.id}
          renderItem={renderLog}
          contentContainerStyle={styles.list}
          accessible={false}
        />
      )}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 22, fontWeight: '700' },
  headerSub: { fontSize: 13, marginTop: 2 },
  clearBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
  },
  clearBtnText: { fontSize: 14, fontWeight: '600' },
  list: { padding: 16, gap: 12, paddingBottom: 32 },
  logCard: { borderRadius: 12, padding: 14, borderWidth: 1, gap: 10 },
  logHeader: { gap: 4 },
  logTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logToolName: { fontSize: 16, fontWeight: '600' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: 12, fontWeight: '600' },
  logMeta: { fontSize: 12, lineHeight: 18 },
  codeBlock: { borderRadius: 8, padding: 10, gap: 4 },
  codeLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  codeText: { fontSize: 12, fontFamily: 'monospace', lineHeight: 18 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyDesc: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
});
