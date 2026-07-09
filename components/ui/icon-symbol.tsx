// Fallback for using MaterialIcons on Android and web.
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SymbolViewProps, SymbolWeight } from 'expo-symbols';
import { ComponentProps } from 'react';
import { OpaqueColorValue, StyleProp, TextStyle } from 'react-native';

type IconMapping = Record<string, ComponentProps<typeof MaterialIcons>['name']>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * SF Symbols → Material Icons 映射表
 * 添加新图标时，在此处增加映射即可
 */
const MAPPING: IconMapping = {
  // 导航
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'chevron.left': 'chevron-left',
  'chevron.down': 'expand-more',
  'chevron.up': 'expand-less',

  // 聊天 / 消息
  'message.fill': 'chat',
  'bubble.left.fill': 'chat-bubble',
  'bubble.right.fill': 'chat-bubble-outline',

  // 模型 / 文件
  'cube.fill': 'view-in-ar',
  'doc.fill': 'description',
  'folder.fill': 'folder',
  'tray.and.arrow.down.fill': 'download',
  'tray.and.arrow.up.fill': 'upload',

  // 工具 / 设置
  'wrench.fill': 'build',
  'gearshape.fill': 'settings',
  'slider.horizontal.3': 'tune',
  'toggles': 'toggle-on',

  // 日志 / 列表
  'list.bullet.rectangle': 'list-alt',
  'doc.text.fill': 'article',

  // 状态
  'checkmark.circle.fill': 'check-circle',
  'xmark.circle.fill': 'cancel',
  'exclamationmark.triangle.fill': 'warning',
  'info.circle.fill': 'info',

  // 媒体
  'play.fill': 'play-arrow',
  'pause.fill': 'pause',
  'stop.fill': 'stop',
  'mic.fill': 'mic',
  'video.fill': 'videocam',

  // 搜索
  'magnifyingglass': 'search',

  // 其他
  'trash.fill': 'delete',
  'plus': 'add',
  'minus': 'remove',
  'arrow.up': 'arrow-upward',
  'arrow.down': 'arrow-downward',
  'arrow.clockwise': 'refresh',
  'square.and.arrow.up': 'share',
  'lock.fill': 'lock',
  'person.fill': 'person',
};

export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  const materialName = MAPPING[name as string] ?? 'help-outline';
  return <MaterialIcons color={color} size={size} name={materialName} style={style} />;
}
