import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useColors } from '@/hooks/use-colors';

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomPadding = Platform.OS === 'web' ? 12 : Math.max(insets.bottom, 8);
  const tabBarHeight = 56 + bottomPadding;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          paddingTop: 8,
          paddingBottom: bottomPadding,
          height: tabBarHeight,
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          borderTopWidth: 0.5,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '对话',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="message.fill" color={color} />
          ),
          tabBarAccessibilityLabel: '对话页面',
        }}
      />
      <Tabs.Screen
        name="models"
        options={{
          title: '模型',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="cube.fill" color={color} />
          ),
          tabBarAccessibilityLabel: '模型管理页面',
        }}
      />
      <Tabs.Screen
        name="tools-settings"
        options={{
          title: '工具',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="wrench.fill" color={color} />
          ),
          tabBarAccessibilityLabel: '工具设置页面',
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '参数',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="slider.horizontal.3" color={color} />
          ),
          tabBarAccessibilityLabel: '推理参数设置页面',
        }}
      />
      <Tabs.Screen
        name="logs"
        options={{
          title: '日志',
          tabBarIcon: ({ color }) => (
            <IconSymbol size={26} name="list.bullet.rectangle" color={color} />
          ),
          tabBarAccessibilityLabel: '工具调用日志页面',
        }}
      />
    </Tabs>
  );
}
