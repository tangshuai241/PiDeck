# TPA 需求对齐首版

状态：首版源码与自动化测试已落地，真实模型与完整桌面联调待验证。日期：2026-10-11。

## 首版做什么

需求对齐是当前对话里的可选步骤，不是另一套任务系统。普通聊天不强制开启对齐，也不改变首页和工作区布局。

开启后，先和 AI 说明目标、材料、范围、需要保留的内容及完成标准。AI 在对话中澄清，并把要求整理到输入框上方的“本次要求”卡片。用户可以继续补充或修改；只有明确确认当前版本后，Pi 才能按要求执行。

卡片沿用现有 Composer 容器、shadcn 控件与主题 token，支持亮暗主题、折叠和长内容滚动。GUI 桥关闭时，卡片仍可通过原生 RPC 状态显示。

## 怎么使用

1. 在 Pi 会话的输入框模式菜单中选择“需求对齐”。
2. 发送本次要求，并提供可读取的材料或直接粘贴材料正文。
3. 查看“本次要求”卡片，在聊天中补充信息或点击“修改要求”。
4. 等待待决定事项解决，且当前回复与排队输入结束。
5. 点击“按这个执行”，确认卡片的当前版本。

如果暂时不做，点击“退出对齐”。运行中的回复需先结束或停止；退出失败时，界面不会把仍在对齐的会话伪装成普通模式。切换到其他模式也会先尝试退出对齐。

执行完成后回到普通对话。会话重开或执行中断不会自动重放已确认的执行，必要时需重新确认要求。

## 边界与保护

- 首版仅支持 Pi，不向 ACP、DSH 或生图后端发送对齐控制命令。
- 对齐期间只允许 `read`、`grep`、`find`、`ls` 和 `alignment_brief`。写工具、`bash`、用户的 `!`/`!!` 命令及未知 MCP 工具均被拒绝。
- Pi 会先执行已注册的斜杠命令，再触发输入 hook。因此宿主在分发前拦截其他斜杠命令，只放行 `/align` 控制命令。首次对齐输入也受这道检查保护。
- 确认绑定 `briefId + revision`。旧卡、未解决的问题、忙碌或有排队输入的运行时不能确认；原生按钮还校验 `sessionId + agentId + runtimeGeneration`。
- 取消状态先持久化，再恢复此前的工具集合。持久化失败不会打开写工具，原本为空的工具集合也不会被替换成默认集合。
- 最新快照损坏或来自未来协议版本时，不回退到更早的可批准状态。历史恢复只看活动分支，并确认实际进程已经注册 `align` 命令；扩展未加载时，旧卡不会强制开启对齐。
- 确认只解除本次对齐的只读闸，不替代原有权限检查，也不表示成果已通过用户验收。

这些检查保护 TPA 分发的对齐流程和 Pi 工具调用，不是针对受信任扩展自主代码或用户外部终端的操作系统沙箱。

## 材料读取限制

AI 应记录实际读到的材料摘要，不能把文件路径当成已读内容。读不到或未核实的信息应明确说明，并保留待补项。

首版禁止对齐阶段运行 `bash`。需要通过外部程序转换的 Word、PDF 等材料尚未覆盖；请先提供可直接读取的文本或粘贴正文。上传、附件引用或路径存在都不等于材料已被读完。

## 与个人工作台的关系

首版借用个人工作台的“理解—修改—明确确认”流程，但不创建 Workbench 任务，不调用它的执行、成果或改稿服务，也不另建任务主账。确认后执行的是当前 Pi 会话。

后续若接入 Workbench，仍须以其服务为任务事实源，复用唯一写入入口、版本检查与请求幂等。TPA 只保存会话与任务的关联，不直接改任务档案。该接入不属于本次实现范围。

## 状态与代码入口

Pi 扩展通过标准 `custom_message`/消息事件发布隐藏快照：

```text
customType: pi-deck-alignment-state
display: false
details.alignment: { schemaVersion: 1, briefId, revision, phase, brief? }
```

`phase` 为 `clarifying`、`ready`、`approved`、`cancelled` 或 `complete`。`AgentRuntimeState.alignment = null` 用于明确清除旧状态。隐藏快照不占可见历史消息序号，普通工具结果不作为确认事实源。

控制命令为 `/align on`、`/align off`、`/align approve <briefId> <revision>` 和 `/align revise <briefId> <revision>`。这些命令由原生控件发送，也可在支持的 Pi 会话中直接使用。

| 职责 | 入口 |
| --- | --- |
| Pi 状态机与工具闸 | `resources/extensions/pi-deck-alignment-mode.ts`、`pi-deck-alignment-state.ts` |
| 共享状态契约与校验 | `src/shared/types/alignment.ts`、`src/shared/alignment.ts` |
| 原生投影与有界历史恢复 | `src/main/pi/AlignmentProjection.ts`、`SessionHistoryReader.ts` |
| 会话身份校验 | `src/main/sessions/SessionRuntimeCoordinator.ts`、`src/main/ipc/sessionIpc.ts` |
| 原生卡片与会话级控制 | `src/renderer/src/components/session/AlignmentCard.tsx`、`src/renderer/src/hooks/useSessionAlignmentControls.ts` |
| 模式策略与隔离 | `src/renderer/src/composerBehavior.ts`、`src/renderer/src/hooks/useComposerModeAvailability.ts` |

扩展可在原有扩展设置中关闭。运行进程是否已加载扩展，以 `get_commands` 结果为准，而不是只看文件是否存在。

## 验证范围

自动化验证覆盖状态字段与预算、活动分支恢复、损坏快照、迟到消息、运行时换代、审批版本、取消失败、命令旁路、模式兼容性和会话隔离。真实浏览器验证使用生产卡片与生产样式，覆盖亮暗主题、折叠、长内容滚动、按钮转发和禁用状态。

本轮类型与格式门禁通过，24 个相关测试文件的 288 项测试全绿，Playwright 3 项通过。最终全量测试为 9313 项：9296 项通过、6 项失败、11 项跳过。6 项失败均在改动前的 `67af8bf8` 隔离工作树复现；本轮曾引入的 15 项集成回归已修复，没有修改原断言来掩盖失败。

仍红的基线项分布在 `configTrustWsl.test.mjs`（2 项）、`dshStartup.test.mjs`（1 项）、`packDshRuntimeCross.test.mjs`（2 项）和 `sessionHeaderLayout.test.mjs`（1 项）。本次不改这些无关功能，不宣称全量全绿。

核心回归命令：

```bash
npm run typecheck
npm run check:format
node --test tests/alignmentState.test.mjs tests/alignmentComposer.test.mjs tests/alignmentControlsHook.test.mjs tests/alignmentHistory.test.mjs tests/alignmentProjection.test.mjs tests/alignmentPromptTarget.test.mjs tests/piDeckAlignmentModeExtension.test.mjs
npx playwright test e2e/alignment-card.spec.ts --output ../../cache/tpa-alignment/playwright
```

本机缺少 Playwright 自带 Chromium 时，可用已安装的 Edge 通道。PowerShell 中先设置 `$env:PIDECK_E2E_BROWSER_CHANNEL = "msedge"`，再执行浏览器测试；测试使用独立配置，不读取用户的浏览器资料。其他源码位置请调整测试输出目录。

尚未验证真实模型端到端任务、完整 Electron 应用和安装包。自动化测试与组件截图不能替代这些验收；本次不发布安装包，也不代表完整第一阶段已完成。
