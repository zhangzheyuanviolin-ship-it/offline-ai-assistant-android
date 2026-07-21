import React, { memo, useMemo } from 'react';
import { StyleProp, Text, TextStyle, View } from 'react-native';

const DEFAULT_CHUNK_SIZE = 800;

function splitAccessibleText(text: string, chunkSize: number): string[] {
  const normalized = text.trim();
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
  const chunks = useMemo(() => splitAccessibleText(text, chunkSize), [text, chunkSize]);
  if (chunks.length === 0) return null;

  return (
    <View accessible={false} importantForAccessibility="yes">
      {chunks.map((chunk, index) => (
        <Text
          key={`${index}_${chunk.length}`}
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
