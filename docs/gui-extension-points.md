# GUI 扩展点参考（插件能力清单）

> 本页表格由 `src/shared/pluginDevCatalog.ts` 生成（`.scratch` 脚本产出后人工核对），
> 镜像契约由 `tests/guiExtensionPointsDoc.test.mjs` 兜底：目录与本文档、桥实现三方
> 漂移会红。给 AI 的完整开发指南由 `pluginDevGuide.ts` 生成（`AI-PLUGIN-GUIDE.md`，双语）——
> 生成器与 `pluginDev:*` IPC 都还在，但应用内入口「设置 → 扩展 → 插件开发」已隐藏（见下），
> 本页是其维护者视角的事实源说明。
>
> ⚠️ **当前状态**：桥（`pi-deck-gui-bridge.ts`）与扩展点面板（`pi-deck-ext-points.ts`）已列入
> `HIDDEN_BUILT_IN_EXTENSIONS`——不再经 `-e` 注入，扩展页也没有开启入口（源文件保留）。
> 下面的落点清单仍然有效，但在桥重新启用前不会生效。

**镜像源（改这些必须同步目录，契约测试会拦）**：

- 15 落点 ← `resources/extensions/pi-deck-gui-bridge-gui-spec.ts` 的 `GUI_SLOT_METHODS`
- 42 节点 kind ← `resources/extensions/pi-deck-gui-bridge-types.ts` 的 `UINode` 联合类型
- pi 原生 API/事件 ← pi 官方 `docs/extensions.md`（升级 pi 时人工核对节选是否有变化）

**安全模型**：插件运行在 pi 的 Node 进程里，拥有用户本人权限；PiDeck 不做进程内沙箱，
防护靠知情同意。UI 侧的声明式约束（tone 色、节点目录、上限）只保护界面。

## pi 原生扩展 API（任何宿主可用）

| API | 说明 |
| --- | --- |
| `pi.registerCommand()` | 注册 / 斜杠命令 |
| `pi.registerTool()` | 给模型添加可调用工具（TypeBox 参数 schema） |
| `pi.registerProvider()` | 添加自定义模型供应商 |
| `pi.registerMcpServer()` | 添加 MCP 服务器 |
| `pi.registerVirtualModel()` | 注册虚拟模型（请求路由/包装） |
| `pi.registerShortcut() / pi.registerFlag()` | 注册快捷键 / CLI 旗标 |
| `pi.on()` | 监听生命周期与消息事件（见下表） |
| `pi.sendUserMessage() / pi.sendMessage()` | 以用户/自定义身份发消息 |
| `pi.appendEntry()` | 把非上下文数据持久化进会话文件 |
| `pi.events` | 跨扩展通信的事件总线 |

## 常用事件（pi.on）

| Event | 说明 |
| --- | --- |
| `session_start` | 会话启动（挂载 UI 落点的推荐时机） |
| `agent_start` | 一轮任务开始 |
| `before_agent_start` | 一轮任务开始前，可改提示词/工具集 |
| `tool_call` | 工具调用（可改参数或阻断） |
| `tool_result` | 工具结果（可改写内容） |
| `message_end` | 消息定稿（可替换保角色） |
| `agent_end` | 一轮任务结束（统计/通知的好时机） |
| `session_shutdown` | 会话结束（清理资源的配对点） |

## GUI 落点（19）

| Method | Slot id | 说明 |
| --- | --- | --- |
| `ctx.ui.gui.setSidebarPanel()` | `sidebar.panel` | 左侧边栏的整块面板 |
| `ctx.ui.gui.setSidebarSection()` | `sidebar.section` | 侧栏内的一个分组区块 |
| `ctx.ui.gui.setContentView()` | `content.view` | 主内容区视图（整页替换，慎用） |
| `ctx.ui.gui.setComposerToolbar()` | `composer.toolbar` | 输入框上方的工具条 |
| `ctx.ui.gui.setTitlebarAction()` | `titlebar.action` | 标题栏动作区按钮 |
| `ctx.ui.gui.setBanner()` | `banner` | 顶部横幅（公告/警告） |
| `ctx.ui.gui.setToolExtra()` | `tool.extra` | 工具消息卡片的附加区 |
| `ctx.ui.gui.setMessageExtra()` | `message.extra` | 消息卡片的附加区 |
| `ctx.ui.gui.setThinkingExtra()` | `thinking.extra` | 思考块的附加区 |
| `ctx.ui.gui.setDialogAction()` | `dialog.action` | 对话框按钮行 |
| `ctx.ui.gui.setDialogBody()` | `dialog.body` | 对话框内容体 |
| `ctx.ui.gui.setSettingsSection()` | `settings.section` | 设置弹窗底部追加一块 |
| `ctx.ui.gui.setConfigPage()` | `config.page` | 「Pi 管理」侧栏里的整页（一级导航） |
| `ctx.ui.gui.setSessionItemExtra()` | `session.item` | 会话列表条目的附加徽标 |
| `ctx.ui.gui.setContextMenuItem()` | `context.menu` | 右键菜单项 |
| `ctx.ui.gui.setTimelineEvent()` | `timeline.event` | 时间线底部的事件条（会话标记/备注） |
| `ctx.ui.gui.setStatusbarItem()` | `statusbar.item` | 会话头部状态区的小条目 |
| `ctx.ui.gui.setTerminalToolbar()` | `terminal.toolbar` | 底部终端面板头部的工具区 |
| `ctx.ui.gui.setGitPanelSection()` | `git.panel.section` | Git 面板底部的附加区块 |

## GUI 交互与服务

| API | 说明 |
| --- | --- |
| `gui.command(id, handler)` | 注册交互回调（按钮 actionId → 处理器） |
| `gui.toast(message, { tone })` | 弹出轻提示 |
| `gui.confirm(title, body, opts)` | 确认对话框（Promise<boolean>） |
| `gui.overlay(node, opts)` | 全屏浮层，返回带 close() 的句柄 |
| `gui.custom(factory, opts)` | 全自定义画布（Promise 结果） |
| `gui.icon(name, svgPath)` | 注册自定义图标供节点引用 |
| `gui.filePicker(opts)` | 宿主原生文件选择框（Promise<string[] \| null>） |
| `gui.openPath(path)` | 用系统默认程序打开文件/目录（Promise<boolean>） |
| `gui.theme` | 宿主主题（语义 tone 档位，禁裸色值） |

### 文本与基础（basic）

| kind | 说明 |
| --- | --- |
| `text` | 文本（style: dim/bold/italic…） |
| `markdown` | Markdown 富文本 |
| `codeblock` | 代码块（language 高亮） |
| `ansi` | ANSI 字符行（降级保命出口） |
| `image` | 图片（src/alt） |
| `icon` | 图标（name + tone） |
| `badge` | 徽标（tone 着色） |
| `divider` | 分隔线（可带 label） |

### 布局容器（layout）

| kind | 说明 |
| --- | --- |
| `spacer` | 占位空白 |
| `vstack` | 纵向堆叠（gap） |
| `hstack` | 横向堆叠（gap） |
| `stack` | 方向堆叠（column/row + align） |
| `grid` | 网格（columns） |
| `split` | 分栏（ratio） |
| `box` | 内边距盒子（padding/bg） |
| `card` | 卡片（title + children） |
| `scroll` | 滚动区（maxHeight；pi-tui 兼容） |
| `scrollarea` | 滚动区（GUI 原生） |
| `collapse` | 可折叠分组（count/actionId） |
| `tabs` | 标签页（active/actionId） |

### 表单控件（form）

| kind | 说明 |
| --- | --- |
| `button` | 按钮（actionId + tone/variant） |
| `input` | 单行输入（actionId） |
| `textarea` | 多行输入（rows） |
| `editor` | 代码编辑器 |
| `select` | 列表选择（pi-tui 兼容） |
| `selectinput` | 下拉选择输入 |
| `checkbox` | 复选框 |
| `switch` | 开关 |
| `slider` | 滑杆（min/max/step） |
| `list` | 可导航列表（selected） |

### 数据展示（data）

| kind | 说明 |
| --- | --- |
| `table` | 表格（columns + rows） |
| `tree` | 树（expanded） |
| `keyvalue` | 键值对列表 |
| `settings` | 设置项列表（pi-tui 兼容） |

### 反馈与浮层（feedback）

| kind | 说明 |
| --- | --- |
| `progress` | 进度条（value/max） |
| `spinner` | 加载指示 |
| `loader` | 加载器（frames 可定制） |
| `toast` | 轻提示（actions 可带按钮） |
| `banner` | 横幅（tone 着色） |
| `modal` | 模态框（title/actions） |

### 宿主原生设置件（native）

| kind | 说明 |
| --- | --- |
| `setting-box` | 宿主设置页同源容器 |
| `setting-row` | 宿主设置页同源行（title/description/level） |

## 硬约束

| Constraint | 说明 |
| --- | --- |
| `MAX_NODES=2000` | 单次序列化节点数上限，超限该贡献整体隐藏 |
| `MAX_DEPTH=32` | 节点树深度上限 |
| `tone-only` | 颜色只能用语义 tone 档（accent/success/warning/error/muted…），禁止裸色值 |
| `no-react` | 禁止返回 React 元素（$$typeof 检测）——声明式节点是唯一通道 |
| `degrade-ansi` | 宿主不认识的 kind 降级为纯文本渲染，绝不抛错 |
| `dynamic-component` | 动态内容必须返回 GuiComponent（render() 每帧重建）；直接返回 GuiNode 只求值一次 |
| `order-default-1000` | 落点 options.order 缺省 1000，升序排；同 order 按 key 字母序 |
| `10hz-ticker` | 桥以 10Hz tick 重新求值贡献并做哈希去重推送——状态变了下一帧自动生效 |
