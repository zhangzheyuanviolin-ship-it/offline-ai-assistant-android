# Offline AI Assistant - APK 构建指南

## 快速开始

### 方式 1：使用 Expo Go（最快）

```bash
cd /home/ubuntu/offline-ai-assistant
pnpm start
```

然后在 Android 设备上安装 Expo Go，扫描显示的二维码即可运行应用。

### 方式 2：构建独立 APK

#### 前置条件
- Android SDK（API 24+）
- Java 11+
- Node.js 18+
- pnpm

#### 构建步骤

```bash
# 1. 进入项目目录
cd /home/ubuntu/offline-ai-assistant

# 2. 安装依赖
pnpm install

# 3. 生成 Android 原生代码
pnpm exec expo prebuild --clean

# 4. 进入 Android 目录
cd android

# 5. 构建 Debug APK（开发用）
./gradlew assembleDebug --no-daemon

# 或构建 Release APK（生产用）
./gradlew assembleRelease --no-daemon
```

#### 生成的 APK 位置

- **Debug APK**: `android/app/build/outputs/apk/debug/app-debug.apk`
- **Release APK**: `android/app/build/outputs/apk/release/app-release.apk`

### 方式 3：使用 EAS Build（云端构建）

```bash
# 安装 EAS CLI
npm install -g eas-cli

# 登录 Expo 账户
eas login

# 构建 APK
eas build --platform android --local
```

## 应用功能

### ✅ 已实现功能

1. **模型管理**
   - 从本地文件系统导入 GGUF 模型
   - 选择和切换当前模型
   - 查看模型详情（文件大小、格式等）
   - 删除不需要的模型

2. **聊天界面**
   - 实时聊天消息显示
   - 消息输入框
   - 推理进度指示
   - 工具调用确认弹窗

3. **工具系统**
   - **Files 工具**：list_dir, read_file, write_file, mkdir, delete, move, rename, compress, decompress
   - **Media 工具**：extract_audio, transcode_video, trim_media, merge_audio, merge_video
   - **WebSearch 工具**：web_search, set_search_engine
   - 工具独立开关（可单独启用/禁用）
   - 工具权限管理（允许/需确认/禁止）

4. **日志系统**
   - 记录最近 50 条工具调用
   - 显示工具名、参数、结果、执行时间
   - 清空日志功能

5. **无障碍支持**
   - 所有控件都有无障碍标签
   - 聊天消息完全可被屏幕阅读器朗读
   - 工具调用对话框可访问
   - 日志列表逐项可读

6. **UI/UX**
   - 深色/浅色主题自动切换
   - 响应式移动端布局
   - 专业的应用图标和品牌设计
   - 清晰的用户反馈和加载状态

### ⏳ 需要集成的功能

1. **推理引擎**
   - 需要集成 llama.cpp 或 ai-core 原生模块
   - 实现 GGUF 模型的实际加载和推理
   - 支持流式输出

2. **多媒体处理**
   - 需要集成 FFmpeg 或 Android MediaCodec
   - 实现音频提取、视频转码等操作

3. **网络搜索**
   - 需要集成 DuckDuckGo API（国际）
   - 需要集成百度/夸克 API（国内）
   - 实现搜索结果解析和摘要

## 测试应用

### 启动应用

```bash
# 使用 Expo Go（推荐快速测试）
pnpm start

# 或直接安装 APK
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

### 测试流程

1. **导入模型**
   - 点击聊天屏幕的"导入模型"按钮
   - 选择一个 GGUF 模型文件
   - 验证模型是否成功导入

2. **选择模型**
   - 点击顶部的模型显示区域
   - 从列表中选择一个模型
   - 验证当前模型是否更新

3. **工具开关**
   - 点击工具开关按钮（WebSearch、Files、Media）
   - 验证开关状态是否改变
   - 打开工具设置屏幕查看详细配置

4. **查看日志**
   - 点击"日志"按钮
   - 查看工具调用历史
   - 验证日志显示是否正确

5. **无障碍测试**
   - 在 Android 设置中启用 TalkBack
   - 验证所有按钮和文本都可被朗读
   - 测试聊天消息的朗读

## 项目结构

```
offline-ai-assistant/
├── app/                          # React Native 应用代码
│   ├── (tabs)/                   # Tab 导航
│   │   ├── index.tsx            # 聊天屏幕
│   │   ├── models.tsx           # 模型管理
│   │   ├── tools-settings.tsx   # 工具设置
│   │   └── logs.tsx             # 日志查看
│   ├── _layout.tsx              # 根布局
│   └── oauth/                   # OAuth 回调
├── components/                   # 可复用组件
│   ├── chat-message.tsx         # 聊天消息
│   ├── tool-confirmation-modal.tsx  # 工具确认
│   └── screen-container.tsx     # 安全区域包装
├── lib/                         # 业务逻辑
│   ├── types.ts                 # 类型定义
│   ├── store.ts                 # 状态管理
│   └── services/
│       ├── model-service.ts     # 模型管理
│       └── tools-service.ts     # 工具执行
├── assets/images/               # 应用图标
├── android/                     # Android 原生代码
├── app.config.ts               # Expo 配置
└── package.json                # 依赖
```

## 常见问题

**Q: 如何在没有 Android SDK 的情况下构建 APK？**
A: 使用 EAS Build 云端构建服务，无需本地 Android 环境。

**Q: 应用运行时出现闪退**
A: 检查 logcat 输出：`adb logcat | grep -i "offline|error"`

**Q: 如何调试应用？**
A: 使用 React Native Debugger 或 Expo DevTools

**Q: 如何发布到 Google Play？**
A: 1. 构建 Release APK 2. 生成签名密钥 3. 上传到 Google Play Console

## 下一步

1. **集成 llama.cpp**：添加原生模块以支持实际的 GGUF 模型推理
2. **实现多媒体工具**：集成 FFmpeg 进行音视频处理
3. **添加网络搜索**：集成搜索引擎 API
4. **性能优化**：优化推理速度和内存使用
5. **高级功能**：流式输出、多轮对话、模型微调

---

**最后更新**: 2026年1月6日
**版本**: 1.0.0
**状态**: 开发版本
