# 重要交接文档 / 致下一位开发者 / CRITICAL HANDOVER

**重要声明**：本文档是离线 AI 助手 Android 项目的强制首读文档。

由于当前开发者（AI 助手）无法继续完成全部原始目标，且与设备上 APK 运行相关的多个关键问题仍悬而未决，本文档详尽列出所有已知问题、未完成功能、技术债务、构建产物状态、设备验证证据，以便任何接手者能够立刻从完整的事实清单开始工作，而不是从零开始重新走一遍用户反馈过的所有坑。

创建时间：2026-07-19

当前构建产物：build18（run id 29693047624，commit 0f79dab4，APK 已安装到设备但存在严重性能问题，见下方问题 1）


## 第 1 节：项目基本背景

仓库：zhangzheyuanviolin-ship-it/offline-ai-assistant-android

主分支：main

技术栈：
- React Native 0.81.5
- Expo SDK 54.0.29
- llama.rn 0.12.6（从 0.12.5 升级）
- react-native-reanimated 4.1.6
- react-native-worklets 0.5.1（通过 nativewind 4 强制引入）
- nativewind ^4.2.1
- tailwindcss ^3.4.17

Android 包名：space.manus.offline.ai.assistant.t20260106034740

CI 工作流文件：.github/workflows/build-apk.yml

设备：24GB 运行内存（约 16GB 可用，已通过 logcat 验证）、aarch64 架构

推理引擎：llama.rn（不调用云端 API，完全本地）

关键依赖被移除实验历史：
- react-native-reanimated 和 react-native-worklets 曾经在 commit 13ce26aa 中被显式从 package.json 移除
- 但被 nativewind 4 通过 react-native-css-interop 作为传递依赖再次拉回
- 最终决定保留新架构（newArchEnabled: true）


## 第 2 节：版本演进与每次提交修复的内容

### 2.1 构建记录与 commit 列表

提交 6b8daa72（2026-07-19）：升级 llama.rn 0.12.5 到 0.12.6（修复 UTF-8、修剪未解码 token）。保留。

提交 a4acc08e（2026-07-19）：app.config.ts 设 newArchEnabled 为 false。已被推翻，见 commit 0f79dab4。

提交 89ce741a（2026-07-19）：lib/services/model-service.ts 在 initLlama 参数中加 no_extra_bufts: true。已确认 no_extra_bufts 是 boolean 类型，存在于 llama.rn 的 NativeContextParams 类型定义，注释为 Disable extra buffer types for weight repacking。保留。

提交 63455157（2026-07-19）：修改 CI 工作流，pnpm install --frozen-lockfile 改为 --no-frozen-lockfile（否则 lockfile 与 package.json 不一致会导致 CI 直接失败）。必须保持。

提交 13ce26aa（2026-07-19）：package.json 中显式移除 react-native-reanimated 和 react-native-worklets。实际无效，nativewind 4 通过 react-native-css-interop 仍将其作为传递依赖拉入。

提交 0f79dab4（2026-07-19）：恢复 app.config.ts 中 newArchEnabled: true（nativewind 4 通过 reanimated 4 要求新架构，否则 assertNewArchitectureEnabledTask 必然失败）。保留，构建成功。

### 2.2 CI 构建结果列表

Run ID 29691783421（commit 89ce741a）：失败，pnpm lockfile 不一致。

Run ID 29692651028（commit 63455157）：失败，pnpm lockfile 不一致；reanimated 4.x 又要求新架构导致另一类失败。

Run ID 29692896028（commit 13ce26aa）：失败，reanimated 4.x 强制 assertNewArchitectureEnabledTask。

Run ID 29693047624（commit 0f79dab4）：成功。当前唯一可用构建。

### 2.3 设备上的 APK 文件状态

文件 OfflineAIAssistant-v1.0.0-build12.apk（55MB），路径 /sdcard/Download/builds/，状态：历史版本，崩溃严重，用户已反馈（保留作对照）。

文件 OfflineAIAssistant-v1.0.0-build18.apk（121MB），路径 /sdcard/Download/builds/，状态：已安装到设备，但性能严重退化（见问题 1）。


## 第 3 节：全部用户反馈问题清单（按反馈顺序）

### 问题 1 — build18 严重性能退化（最新、最致命）

反馈时间：build18 安装后立即。

症状：用户发送提示词后模型能输出，但输出速度从历史版本的约 12 至 13 tokens 每秒（4B 模型，手机端合理范围）退化到约 2 tokens 每秒。用户原话：我根本已经没有心情测他到底会不会导致应用闪退崩溃了，因为这种输出速度没有任何意义。

状态：完全未解决，已移交。

已尝试的方案：
- 升级 llama.rn（理论上包含性能改进，但实际性能反而下降）
- 添加 no_extra_bufts: true（减轻堆损坏，但增加内存分配开销可能是性能下降原因之一）
- 开启新架构 newArchEnabled: true（用 reanimated 4 加 bridgeless JSI，但 llama.rn 0.12.6 官方声称 Issue #354 修复）

疑似原因线索：
- no_extra_bufts: true 会禁用 weight repacking 的额外缓冲类型，这可能反而拖慢首次解码（虽然减少堆损坏但增加内存分配次数）
- llama.rn 0.12.6 引入了 MTP 和投机解码支持（Issue #355，sync llama.cpp to b9769 with Gemma MTP support），但 4B 模型可能并不一定从这些功能获利
- 没有 llama.rn 0.12.6 的 aarch64 性能回归 issue 被调查过

接手者建议：先回滚 no_extra_bufts: true 到默认 false 测一次；测试 llama.rn 0.12.5 的速度作为性能基线（即使有 UTF-8 bug）；仔细读 lib/services/model-service.ts 的完整调用层。

### 问题 2 — 闪退崩溃（历史最严重）

反馈时间：build12 之后多次。

症状：
- 第一次完整输出后 2 至 3 秒闪退回主屏幕（内容保留）
- 第二次输出到一半直接闪退（内容丢失）

根因分析（基于 logcat 69437 行 加 llama.rn issue 调查）：
- 已排除：native SIGSEGV（无 tombstone）
- 已排除：OOM（设备 23GB 内存 16GB 可用）
- ANR 文件确认主线程阻塞

高度怀疑的三层根因（已对应实施修复）：
- 第 1 层：UTF-8 编码导致输入崩（已升级 llama.rn 0.12.6 修复）
- 第 2 层：mul_mat 堆损坏 Issue #350（已加 no_extra_bufts: true 缓解）
- 第 3 层：bridgeless JSI 兼容 Issue #354（官方说 0.12.6 修复）

状态：build18 是否彻底解决此问题尚未验证（因问题 1 性能问题导致用户拒绝测试）。logcat 监控文件 /data/local/tmp/crash_log.txt 在问题恢复测试后可作为对照。

### 问题 3 — 约 300 token 后闪退崩溃

症状：模型正常输出约 300 多个 token 后应用闪退崩溃回主屏幕。

状态：未解决。可能是上面问题 2 的同一根因在更长上下文下的表现，但未独立验证。也可能是 llama.rn 上 KV cache 在长上下文下溢出导致 OOM 或 illegal access。

### 问题 4 — 大模型导入和加载闪退

症状：用户手机（24GB RAM）能正常运行其他 Android 本地 AI 应用跑 30B 稀疏架构模型（每次只激活 3B），但本应用导入同等参数量级模型时直接崩溃。

背景：用户设备明显能力足够，说明不是硬件限制。

状态：未解决。可能的诊断方向：
- 应用的导入器（lib/services/model-service.ts）是否对大模型做了不恰当的预读或校验
- 是否对大文件读取路径分片不足
- 是否加载时机与 llama.rn init 时机死锁

接手建议：在 logcat 中专门跑一次大模型导入流程，对比崩溃点与 llama.rn 0.12.6 的 init 路径。

### 问题 5 — 工具调用：网络搜索不可用

症状：有几次模型能正常输出，但没有方法正常调用工具来进行网络搜索。

状态：未解决。模型层与 tool service 层集成未完成。

### 问题 6 — 工具配置：2 个搜索引擎根本无法配置

症状：4 个网络搜索引擎中 2 个需要 API 密钥的根本无法配置。

用户判断：我估计都还没有正常集成，只是在页面上面给了一个提示标签摆摆样子。

状态：未解决。app/(tabs)/tools-settings.tsx 中可能只画了 UI 占位但没有真实持久化 API key 的存储逻辑。

### 问题 7 — 工作区文件夹授权未实现

症状：模型操作工作区文件夹没有给用户手动筛选授权哪个文件夹给模型操作的界面。

状态：未解决。

### 问题 8 — 媒体处理工具模块未实现

症状：媒体处理工具（图片和音视频处理）仍是一个空模块，没有落地。

状态：未解决。

### 问题 9 — 无历史聊天 / 历史消息管理页面

症状：应用没有历史聊天 / 历史消息管理页面。

状态：未解决。

### 问题 10 — 模型状态前后端不同步

症状：完全关闭应用重启后，主聊天页面提示用户到模型管理页加载模型；但聊天页面状态仍显示上一个会话的模型还在加载中状态。用户需先点击卸载才能重新加载。

用户判断：模型管理页面上面的加载和卸载状态和模型真实的加载和卸载状态前后端根本没有同步。

状态：未解决。可能涉及 lib/store.ts 状态持久化策略与 app/(tabs)/index.tsx 渲染逻辑不一致。


## 第 4 节：仓库内已有的关键文件指引

文件 BUILD_APK.md：构建 APK 的方式（不是本文档，请勿混淆）。

文件 DELIVERY.md：交付说明。

文件 TESTING.md：测试说明。

文件 todo.md：待办列表。

文件 app.config.ts：Expo 配置。当前 newArchEnabled: true（必须保持）。

文件 package.json：依赖声明。llama.rn 锁 0.12.6。

文件 lib/services/model-service.ts：L100 有 no_extra_bufts: true 的修复（问题 1 的疑似原因之一）。

文件 .github/workflows/build-apk.yml：必须保持 --no-frozen-lockfile（修复 commit 63455157）。

文件 app/(tabs)/tools-settings.tsx：工具设置页（问题 6 的位置）。

文件 lib/store.ts：状态管理（问题 10 的嫌疑位置）。

文件 app/(tabs)/index.tsx：主聊天页（问题 10 的嫌疑位置）。

文件 app/(tabs)/models.tsx：模型管理页（问题 10 的嫌疑位置）。


## 第 5 节：接手者建议的优先顺序

第 1 优先：性能回归问题 1。这是阻断性 bug，用户拒绝继续测试任何东西。先回滚 no_extra_bufts: true 到默认 false（保留升级 llama.rn）测速度基线。

第 2 优先：闪退测试。性能问题缓解后，再仔细验证问题 2 和问题 3 是否真的修复（单次输出 1000+ tokens）。

第 3 优先：大模型导入。找一台或用 logcat 抓导入流程，对比 llama.rn init 顺序。

第 4 优先：功能缺口（问题 5 至 9）。这些是用户明确表态的未交付功能，可能要新增需求池。


## 第 6 节：已知绝对不能改的东西

- app.config.ts 中的 newArchEnabled: true（去掉会让 nativewind 4 链崩）
- CI 工作流中的 --no-frozen-lockfile（去掉会让 lockfile 冲突直接失败）
- package.json 中 llama.rn 锁 0.12.6（0.12.5 有 bug 但不要降级）


## 第 7 节：AI 助手之前的失败教训（防止重蹈覆辙）

教训 1（中途试图关闭新架构）：错误决策，构建失败后浪费了多个 commit cycle 才纠错。下次遇到构建冲突时，先调查 nativewind 和 reanimated 链路后再决定。

教训 2（未充分验证 no_extra_bufts 真实效果）：从概念上觉得有用就加了，没有实测过对性能的负面影响。

教训 3（pkill 一次杀多进程被拒）：pkill 一次只能接一个 pattern，需要分两次写。

教训 4（terminal session 卡死问题）：长 curl 和长 sleep 命令容易让 session 卡死，下次启动长任务时务必用 background=true 加 terminal_wait。


## 第 8 节：关闭说明

本次开发任务宣告结束并正式交接。当前 AI 助手在构建成功（build18 已经安装成功）后即终止进一步工作。所有 build18 安装后的真实设备验证、性能验证、崩溃验证均未由用户执行（因性能严重退化到无法接受）。

请接手者从修复问题 1 性能回归开始，不要从再读一遍代码开始。
