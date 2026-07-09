import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { ScreenContainer } from '@/components/screen-container';
import { useColors } from '@/hooks/use-colors';
import { useAppStore } from '@/lib/store';
import { SearchEngine } from '@/lib/types';

export default function ToolsSettingsScreen() {
  const colors = useColors();
  const {
    toolsConfig,
    toggleToolCategory,
    setSearchEngine,
    setSearchApiKey,
    setSearchMaxResults,
    setToolsConfig,
  } = useAppStore();

  const engines: Array<{ key: SearchEngine; label: string; hint: string; needsKey?: 'tavily' | 'exa' }> = [
    { key: 'tavily',     label: 'Tavily AI',   hint: '专为 AI 优化，返回结构化摘要（推荐）', needsKey: 'tavily' },
    { key: 'exa',        label: 'Exa AI',      hint: '语义向量搜索，擅长学术和技术内容',     needsKey: 'exa' },
    { key: 'duckduckgo', label: 'DuckDuckGo',  hint: '无需 API Key，注重隐私' },
    { key: 'baidu',      label: '百度',         hint: '无需 API Key，适合中文内容' },
  ];

  const currentEngine = toolsConfig.WebSearch.engine;
  const currentEngineInfo = engines.find((e) => e.key === currentEngine);

  function promptApiKey(provider: 'tavily' | 'exa') {
    const label = provider === 'tavily' ? 'Tavily' : 'Exa';
    const currentKey = provider === 'tavily' ? toolsConfig.WebSearch.tavilyApiKey : toolsConfig.WebSearch.exaApiKey;
    Alert.prompt(
      `配置 ${label} API Key`,
      `请输入您的 ${label} API Key。\n获取地址：${provider === 'tavily' ? 'https://tavily.com' : 'https://exa.ai'}`,
      (key: string | undefined) => {
        if (key !== undefined) setSearchApiKey(provider, key.trim());
      },
      'plain-text',
      currentKey,
      'default'
    );
  }

  function promptMaxResults() {
    Alert.prompt(
      '设置返回条目数',
      '每次搜索返回的最大结果数量（1-20）',
      (val: string | undefined) => {
        const n = parseInt(val ?? '', 10);
        if (!isNaN(n)) setSearchMaxResults(n);
      },
      'plain-text',
      String(toolsConfig.WebSearch.maxResults),
      'number-pad'
    );
  }

  return (
    <ScreenContainer>
      <ScrollView
        contentContainerStyle={styles.container}
        accessible={false}
      >
        <Text
          style={[styles.title, { color: colors.foreground }]}
          accessibilityRole="header"
        >
          工具设置
        </Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          管理 AI 可调用的工具类别和权限
        </Text>

        {/* ── WebSearch ── */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>🔍 网络搜索</Text>
              <Text style={[styles.cardDesc, { color: colors.muted }]}>
                允许 AI 搜索互联网信息
              </Text>
            </View>
            <Switch
              value={toolsConfig.WebSearch.enabled}
              onValueChange={() => toggleToolCategory('WebSearch')}
              accessible
              accessibilityLabel="网络搜索工具开关"
              accessibilityHint={`当前${toolsConfig.WebSearch.enabled ? '已启用' : '已禁用'}，双击切换`}
              accessibilityRole="switch"
              trackColor={{ false: colors.border, true: colors.primary }}
            />
          </View>

          {toolsConfig.WebSearch.enabled && (
            <>
              {/* 搜索引擎选择 */}
              <Text style={[styles.sectionLabel, { color: colors.muted }]}>搜索引擎</Text>
              <View style={styles.engineGrid}>
                {engines.map((eng) => {
                  const isSelected = currentEngine === eng.key;
                  const hasKey = eng.needsKey
                    ? (eng.needsKey === 'tavily' ? !!toolsConfig.WebSearch.tavilyApiKey : !!toolsConfig.WebSearch.exaApiKey)
                    : true;
                  return (
                    <TouchableOpacity
                      key={eng.key}
                      style={[
                        styles.engineBtn,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.background,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() => setSearchEngine(eng.key)}
                      accessible
                      accessibilityRole="radio"
                      accessibilityLabel={`搜索引擎：${eng.label}`}
                      accessibilityHint={`${eng.hint}，${isSelected ? '当前已选中' : '双击选择'}`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text
                        style={[
                          styles.engineBtnText,
                          { color: isSelected ? '#fff' : colors.foreground },
                        ]}
                      >
                        {eng.label}
                      </Text>
                      {eng.needsKey && (
                        <Text
                          style={[
                            styles.engineKeyBadge,
                            { color: hasKey ? colors.success : colors.warning },
                          ]}
                        >
                          {hasKey ? '✓ Key' : '需 Key'}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* 当前引擎说明 */}
              {currentEngineInfo && (
                <Text style={[styles.hint, { color: colors.muted }]}>
                  {currentEngineInfo.hint}
                </Text>
              )}

              {/* Tavily API Key 配置 */}
              <View style={styles.apiKeyRow}>
                <View style={styles.apiKeyInfo}>
                  <Text style={[styles.apiKeyLabel, { color: colors.foreground }]}>Tavily API Key</Text>
                  <Text style={[styles.apiKeyValue, { color: colors.muted }]}>
                    {toolsConfig.WebSearch.tavilyApiKey
                      ? `已配置 (${toolsConfig.WebSearch.tavilyApiKey.substring(0, 8)}...)`
                      : '未配置'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.apiKeyBtn, { backgroundColor: colors.primary }]}
                  onPress={() => promptApiKey('tavily')}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel="配置 Tavily API Key"
                  accessibilityHint="双击打开 API Key 输入框"
                >
                  <Text style={styles.apiKeyBtnText}>
                    {toolsConfig.WebSearch.tavilyApiKey ? '修改' : '配置'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Exa API Key 配置 */}
              <View style={styles.apiKeyRow}>
                <View style={styles.apiKeyInfo}>
                  <Text style={[styles.apiKeyLabel, { color: colors.foreground }]}>Exa API Key</Text>
                  <Text style={[styles.apiKeyValue, { color: colors.muted }]}>
                    {toolsConfig.WebSearch.exaApiKey
                      ? `已配置 (${toolsConfig.WebSearch.exaApiKey.substring(0, 8)}...)`
                      : '未配置'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.apiKeyBtn, { backgroundColor: colors.primary }]}
                  onPress={() => promptApiKey('exa')}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel="配置 Exa API Key"
                  accessibilityHint="双击打开 API Key 输入框"
                >
                  <Text style={styles.apiKeyBtnText}>
                    {toolsConfig.WebSearch.exaApiKey ? '修改' : '配置'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* 返回条目数 */}
              <View style={styles.apiKeyRow}>
                <View style={styles.apiKeyInfo}>
                  <Text style={[styles.apiKeyLabel, { color: colors.foreground }]}>每次返回条目数</Text>
                  <Text style={[styles.apiKeyValue, { color: colors.muted }]}>
                    当前：{toolsConfig.WebSearch.maxResults} 条（范围 1-20）
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.apiKeyBtn, { backgroundColor: colors.primary }]}
                  onPress={promptMaxResults}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`设置搜索返回条目数，当前 ${toolsConfig.WebSearch.maxResults} 条`}
                  accessibilityHint="双击打开数量输入框"
                >
                  <Text style={styles.apiKeyBtnText}>修改</Text>
                </TouchableOpacity>
              </View>

              {/* 搜索权限 */}
              <Text style={[styles.sectionLabel, { color: colors.muted }]}>执行权限</Text>
              <View style={styles.permRow}>
                {(['ALLOW', 'ASK', 'FORBID'] as const).map((level) => {
                  const isSelected = toolsConfig.WebSearch.permissionLevel === level;
                  const labels = { ALLOW: '直接执行', ASK: '需要确认', FORBID: '禁止' };
                  return (
                    <TouchableOpacity
                      key={level}
                      style={[
                        styles.permBtn,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.background,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() =>
                        setToolsConfig({
                          WebSearch: { ...toolsConfig.WebSearch, permissionLevel: level },
                        })
                      }
                      accessible
                      accessibilityRole="radio"
                      accessibilityLabel={`搜索权限：${labels[level]}`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text
                        style={[
                          styles.permBtnText,
                          { color: isSelected ? '#fff' : colors.foreground },
                        ]}
                      >
                        {labels[level]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
        </View>

        {/* ── Files ── */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>📁 文件管理</Text>
              <Text style={[styles.cardDesc, { color: colors.muted }]}>
                读写、移动、压缩本地文件
              </Text>
            </View>
            <Switch
              value={toolsConfig.Files.enabled}
              onValueChange={() => toggleToolCategory('Files')}
              accessible
              accessibilityLabel="文件管理工具开关"
              accessibilityHint={`当前${toolsConfig.Files.enabled ? '已启用' : '已禁用'}，双击切换`}
              accessibilityRole="switch"
              trackColor={{ false: colors.border, true: colors.primary }}
            />
          </View>

          {toolsConfig.Files.enabled && (
            <>
              <Text style={[styles.sectionLabel, { color: colors.muted }]}>危险操作权限</Text>
              <View style={styles.permRow}>
                {(['ALLOW', 'ASK', 'FORBID'] as const).map((level) => {
                  const isSelected = toolsConfig.Files.dangerousPermission === level;
                  const labels = { ALLOW: '直接执行', ASK: '需要确认', FORBID: '禁止' };
                  return (
                    <TouchableOpacity
                      key={level}
                      style={[
                        styles.permBtn,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.background,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() =>
                        setToolsConfig({
                          Files: { ...toolsConfig.Files, dangerousPermission: level },
                        })
                      }
                      accessible
                      accessibilityRole="radio"
                      accessibilityLabel={`危险操作权限：${labels[level]}`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text
                        style={[
                          styles.permBtnText,
                          { color: isSelected ? '#fff' : colors.foreground },
                        ]}
                      >
                        {labels[level]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[styles.hint, { color: colors.muted }]}>
                危险操作包括：删除、覆盖、移动文件
              </Text>
            </>
          )}
        </View>

        {/* ── Media ── */}
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderText}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>🎬 多媒体处理</Text>
              <Text style={[styles.cardDesc, { color: colors.muted }]}>
                提取音频、转码视频、裁剪合并
              </Text>
            </View>
            <Switch
              value={toolsConfig.Media.enabled}
              onValueChange={() => toggleToolCategory('Media')}
              accessible
              accessibilityLabel="多媒体处理工具开关"
              accessibilityHint={`当前${toolsConfig.Media.enabled ? '已启用' : '已禁用'}，双击切换`}
              accessibilityRole="switch"
              trackColor={{ false: colors.border, true: colors.primary }}
            />
          </View>

          {toolsConfig.Media.enabled && (
            <>
              <Text style={[styles.sectionLabel, { color: colors.muted }]}>执行权限</Text>
              <View style={styles.permRow}>
                {(['ALLOW', 'ASK', 'FORBID'] as const).map((level) => {
                  const isSelected = toolsConfig.Media.permissionLevel === level;
                  const labels = { ALLOW: '直接执行', ASK: '需要确认', FORBID: '禁止' };
                  return (
                    <TouchableOpacity
                      key={level}
                      style={[
                        styles.permBtn,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.background,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                      onPress={() =>
                        setToolsConfig({
                          Media: { ...toolsConfig.Media, permissionLevel: level },
                        })
                      }
                      accessible
                      accessibilityRole="radio"
                      accessibilityLabel={`媒体工具权限：${labels[level]}`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text
                        style={[
                          styles.permBtnText,
                          { color: isSelected ? '#fff' : colors.foreground },
                        ]}
                      >
                        {labels[level]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
        </View>

        {/* ── Info ── */}
        <View style={[styles.infoBox, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
          <Text style={[styles.infoTitle, { color: colors.foreground }]}>使用说明</Text>
          <Text style={[styles.infoText, { color: colors.muted }]}>
            {'• Tavily 和 Exa 是专为 AI 优化的搜索 API，返回结构化摘要，更适合 AI 工具调用。\n'}
            {'• DuckDuckGo 和百度无需 API Key，但返回内容质量不如 AI 优化引擎。\n'}
            {'• 已禁用的工具不会注入到模型的工具描述中，有助于节省上下文长度。\n'}
            {'• 危险操作（删除、覆盖）建议设置为"需要确认"，防止意外数据丢失。'}
          </Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 32 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  subtitle: { fontSize: 14, marginBottom: 8 },
  card: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 12 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardHeaderText: { flex: 1, marginRight: 12 },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  cardDesc: { fontSize: 13, marginTop: 2 },
  sectionLabel: { fontSize: 13, fontWeight: '500' },
  engineGrid: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  engineBtn: { width: '48%', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, alignItems: 'center', gap: 2 },
  engineBtnText: { fontSize: 14, fontWeight: '600' },
  engineKeyBadge: { fontSize: 11, fontWeight: '500' },
  apiKeyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
  apiKeyInfo: { flex: 1, marginRight: 12 },
  apiKeyLabel: { fontSize: 14, fontWeight: '500' },
  apiKeyValue: { fontSize: 12, marginTop: 2 },
  apiKeyBtn: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8 },
  apiKeyBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  permRow: { flexDirection: 'row', gap: 8 },
  permBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, alignItems: 'center' },
  permBtnText: { fontSize: 13, fontWeight: '500' },
  hint: { fontSize: 12 },
  infoBox: { borderRadius: 12, padding: 16, borderWidth: 1, gap: 8 },
  infoTitle: { fontSize: 15, fontWeight: '600' },
  infoText: { fontSize: 13, lineHeight: 20 },
});
