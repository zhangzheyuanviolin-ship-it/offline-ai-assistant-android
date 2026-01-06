import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Switch,
} from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useAppStore } from '@/lib/store';
import { useColors } from '@/hooks/use-colors';

/**
 * 工具设置屏幕
 */
export default function ToolsSettingsScreen() {
  const colors = useColors();
  const {
    toolsConfig,
    toggleToolCategory,
    setToolsConfig,
    setSearchEngine,
  } = useAppStore();

  return (
    <ScreenContainer className="flex-1 bg-background">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {/* 标题 */}
        <View>
          <Text className="text-2xl font-bold text-foreground mb-2">⚙️ Tools Settings</Text>
          <Text className="text-sm text-muted">
            Enable or disable tool categories and configure permissions
          </Text>
        </View>

        {/* WebSearch 工具 */}
        <View className="bg-surface rounded-lg p-4 border border-border">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-foreground">🔍 Web Search</Text>
            <Switch
              value={toolsConfig.WebSearch.enabled}
              onValueChange={() => toggleToolCategory('WebSearch')}
              accessible={true}
              accessibilityLabel="Web Search toggle"
              accessibilityHint={`Web Search is ${toolsConfig.WebSearch.enabled ? 'enabled' : 'disabled'}`}
              accessibilityRole="switch"
            />
          </View>

          {toolsConfig.WebSearch.enabled && (
            <>
              <Text className="text-sm text-muted mb-2">Search Engine:</Text>
              <View className="flex-row gap-2 mb-3">
                <TouchableOpacity
                  onPress={() => setSearchEngine('international')}
                  className={`flex-1 py-2 rounded-lg border ${
                    toolsConfig.WebSearch.engine === 'international'
                      ? 'bg-primary border-primary'
                      : 'bg-background border-border'
                  }`}
                  accessible={true}
                  accessibilityRole="button"
                  accessibilityLabel="International search engine"
                  accessibilityHint={`${toolsConfig.WebSearch.engine === 'international' ? 'Selected' : 'Not selected'}`}
                >
                  <Text
                    className={`text-center text-sm font-semibold ${
                      toolsConfig.WebSearch.engine === 'international'
                        ? 'text-background'
                        : 'text-foreground'
                    }`}
                  >
                    🌍 International
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => setSearchEngine('domestic')}
                  className={`flex-1 py-2 rounded-lg border ${
                    toolsConfig.WebSearch.engine === 'domestic'
                      ? 'bg-primary border-primary'
                      : 'bg-background border-border'
                  }`}
                  accessible={true}
                  accessibilityRole="button"
                  accessibilityLabel="Domestic search engine"
                  accessibilityHint={`${toolsConfig.WebSearch.engine === 'domestic' ? 'Selected' : 'Not selected'}`}
                >
                  <Text
                    className={`text-center text-sm font-semibold ${
                      toolsConfig.WebSearch.engine === 'domestic'
                        ? 'text-background'
                        : 'text-foreground'
                    }`}
                  >
                    🏠 Domestic
                  </Text>
                </TouchableOpacity>
              </View>

              <Text className="text-xs text-muted">
                Permission Level: {toolsConfig.WebSearch.permissionLevel}
              </Text>
            </>
          )}
        </View>

        {/* Files 工具 */}
        <View className="bg-surface rounded-lg p-4 border border-border">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-foreground">📁 Files</Text>
            <Switch
              value={toolsConfig.Files.enabled}
              onValueChange={() => toggleToolCategory('Files')}
              accessible={true}
              accessibilityLabel="Files toggle"
              accessibilityHint={`Files tool is ${toolsConfig.Files.enabled ? 'enabled' : 'disabled'}`}
              accessibilityRole="switch"
            />
          </View>

          {toolsConfig.Files.enabled && (
            <>
              <Text className="text-sm text-muted mb-2">Available Operations:</Text>
              <View className="gap-1 mb-3">
                <Text className="text-xs text-muted">• list_dir - List directory contents</Text>
                <Text className="text-xs text-muted">• read_file - Read file content</Text>
                <Text className="text-xs text-muted">• write_file - Create or write file</Text>
                <Text className="text-xs text-muted">• mkdir - Create directory</Text>
                <Text className="text-xs text-muted">• delete - Delete file or directory</Text>
                <Text className="text-xs text-muted">• move - Move or rename file</Text>
                <Text className="text-xs text-muted">• compress - Compress to ZIP</Text>
                <Text className="text-xs text-muted">• decompress - Extract ZIP</Text>
              </View>

              <Text className="text-xs text-muted">
                Permission Level: {toolsConfig.Files.permissionLevel}
              </Text>
            </>
          )}
        </View>

        {/* Media 工具 */}
        <View className="bg-surface rounded-lg p-4 border border-border">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-foreground">🎬 Media</Text>
            <Switch
              value={toolsConfig.Media.enabled}
              onValueChange={() => toggleToolCategory('Media')}
              accessible={true}
              accessibilityLabel="Media toggle"
              accessibilityHint={`Media tool is ${toolsConfig.Media.enabled ? 'enabled' : 'disabled'}`}
              accessibilityRole="switch"
            />
          </View>

          {toolsConfig.Media.enabled && (
            <>
              <Text className="text-sm text-muted mb-2">Available Operations:</Text>
              <View className="gap-1 mb-3">
                <Text className="text-xs text-muted">• extract_audio - Extract audio from video</Text>
                <Text className="text-xs text-muted">• transcode_video - Convert video format</Text>
                <Text className="text-xs text-muted">• trim_media - Trim audio or video</Text>
                <Text className="text-xs text-muted">• merge_audio - Merge audio files</Text>
                <Text className="text-xs text-muted">• merge_video - Merge video files</Text>
              </View>

              <Text className="text-xs text-muted">
                Permission Level: {toolsConfig.Media.permissionLevel}
              </Text>
            </>
          )}
        </View>

        {/* 信息提示 */}
        <View className="bg-primary/10 rounded-lg p-4 border border-primary">
          <Text className="text-sm text-foreground font-semibold mb-2">ℹ️ Important</Text>
          <Text className="text-xs text-muted">
            Disabled tools will not be available to the AI model. This helps prevent unnecessary
            context usage and keeps the model focused on the tools you need.
          </Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}
