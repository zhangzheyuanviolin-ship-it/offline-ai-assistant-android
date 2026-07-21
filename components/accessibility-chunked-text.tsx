import React, { memo, useMemo } from 'react';
import { StyleProp, Text, TextStyle, View } from 'react-native';

const DEFAULT_CHUNK_SIZE = 800;
const STREAM_CHUNK_SIZE = 240;

function splitAccessibleText(text: string, chunkSize: number, trim: boolean): string[] {
  const normalized = trim ? text.trim() : text;
  if (!normalized) return [];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + chunkSize);
    if (end < normalized.length) {
      const preferred = Math.max(
        normalized.lastIndexOf('\n', end),
        normalized.lastIndexOf('。', end),
        normalized.lastIndexOf('！', end),
        normalized.lastIndexOf('？', end),
        normalized.lastIndexOf('. ', end)
      );
      if (preferred > cursor + Math.floor(chunkSize * 0.55)) end = preferred + 1;
    }
    chunks.push(normalized.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export const AccessibilityChunkedText = memo(function AccessibilityChunkedText({
  text,
  label,
  style,
  chunkSize = DEFAULT_CHUNK_SIZE,
}: {
  text: string;
  label: string;
  style?: StyleProp<TextStyle>;
  chunkSize?: number;
}) {
  const chunks = useMemo(() => splitAccessibleText(text, chunkSize, true), [text, chunkSize]);
  if (chunks.length === 0) return null;

  return (
    <View accessible={false} importantForAccessibility="yes">
      {chunks.map((chunk, index) => (
        <Text
          key={`final_${index}`}
          style={style}
          selectable
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${label}${chunks.length > 1 ? `，第 ${index + 1} 段，共 ${chunks.length} 段` : ''}：${chunk}`}
        >
          {chunk}
        </Text>
      ))}
    </View>
  );
});

/**
 * 流式文本只更新最后一个最多 240 字的节点。已经完成的节点保持 key 和内容稳定，
 * 不使用 liveRegion 自动朗读整段文本，避免屏幕阅读器反复重建超长无障碍节点。
 */
export const AccessibilityStreamingText = memo(function AccessibilityStreamingText({
  text,
  label,
  style,
  chunkSize = STREAM_CHUNK_SIZE,
}: {
  text: string;
  label: string;
  style?: StyleProp<TextStyle>;
  chunkSize?: number;
}) {
  const chunks = useMemo(() => splitAccessibleText(text, chunkSize, false), [text, chunkSize]);
  if (chunks.length === 0) return null;

  return (
    <View accessible={false} importantForAccessibility="yes">
      {chunks.map((chunk, index) => (
        <Text
          key={`stream_${index}`}
          style={style}
          selectable
          accessible
          accessibilityRole="text"
          accessibilityLabel={`${label}，第 ${index + 1} 段：${chunk}`}
        >
          {chunk}
        </Text>
      ))}
    </View>
  );
});
