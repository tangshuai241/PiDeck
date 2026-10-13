# TPA 减负前的上游合并评审

状态：调研完成，用户已决定采用完整合并后删除四组功能；代码与四项删除已完成本轮验收，用户已确认提交与合并，尚未推送。日期：2026-10-13。

## 采用的决定

用户最终选择先同步自己的云端主分支，再完整合并上游，保护需求对齐和文稿功能。合并后删除 ACP、局域网 Web、在线推荐与商店、上游公告与遥测。Pi、DSH、生图、生视频、飞书、桌宠和社区词库保留。

此前逐项移植建议及后续提交表是本次调研的评审依据，不再作为当前实施顺序。实际范围、兼容边界和验证结果以[应用功能减负方案](tpa-feature-reduction.md)为准。

v0.7.6 已在当前分支历史中。合并对象是 origin/main 的文稿更新和 upstream/main 的后续改动。整应用更新指向自己的 fork；TPA 对齐与文稿扩展固定使用随包版本。

## 版本和分支核对

| 对象 | 本轮核对结果 | 含义 |
| --- | --- | --- |
| 上游 v0.7.6 | `4a3b8c35`，2026-09-17 发布 | 是历史正式版本，不是当前源码之后的新版本 |
| 上游最新正式 Release | v0.8.0，2026-10-07 发布 | GitHub Release 与主分支源码版本不是同一口径 |
| 当前工作区 | `b851938d`，`package.json` 为 0.9.0 | 包含 v0.7.6；已有 TPA 需求对齐 |
| 当前与上游的共同基线 | `8c18f601` | 上游更新应从这个共同基线检查，不应只按版本数字判断 |
| 自己的云端 `origin/main` | `b49b29631bb833d50453e0ff16753c1bed6a0810` | 比当前分支多 20 个提交，其中 19 个非合并提交；增加独立文稿能力 |
| 上游 `upstream/main` | `a8e38e8ca8e47dcccf0d5542fe60a268b8dd4831` | 有 78 个当前分支未包含的提交，其中 63 个非合并提交 |

`git merge-base --is-ancestor v0.7.6 HEAD` 返回 0。当前 HEAD 也是 `origin/main` 的祖先；从提交历史看，同步自己的云端主分支可快进。工作区已有锁文件修改与未提交的减负方案，实施同步时仍应保留这些文件。

上游共同基线到本次检查的上游主分支共改变 412 个文件，新增 19,277 行、删除 2,431 行。该数字包括代码、测试和文档，不代表安装包或运行性能变化。

发布来源：[v0.7.6](https://github.com/ayuayue/PiDeck/releases/tag/v0.7.6)、[v0.8.0](https://github.com/ayuayue/PiDeck/releases/tag/v0.8.0)。自己的文稿集成见 [PR #4](https://github.com/tangshuai241/PiDeck/pull/4)。

## 先同步自己的 TPA 主分支

云端已经增加正式文稿的材料读取、批准绑定、制作观察、成果归档、版本管理和普通聊天改稿。本次检查的云端源码明确采用 TPA 独立执行，不依赖 Workbench 服务。当前本地的路线文档还停留在此前方案，不应继续用旧文档作为删除依据。

云端也补了本次合并应保留的边界：

- 运行时事件携带 `sessionId + agentId + runtimeGeneration`，不将旧进程事件认成新执行。
- 文稿绑定不授予执行权限；执行与批准仍须匹配当前准备记录和版本。
- 同一尝试不应因重复绑定、缓存淘汰、重启或分支切换再次执行。
- 机器发出的改稿指令不被当成人类新授权。
- 归档版本、程序检查与用户认可分别记录。
- 材料转换需要 anydoc，因此新对齐版本开放 `bash`，沿用 Pi 权限；不再声称对齐阶段绝对只读。

宜将云端这 20 个提交作为 TPA 的新基线，不单独摘取早期文稿提交。后续修复已经补齐批准续跑、Windows 目录名、重复执行与历史去重问题，拆开吸收容易回到已修过的状态。

这是提交历史与针对性回归支持的宜，不是完整文稿质量、安全或真实模型验收结论。

## 宜先移植的上游修复

### A. 文件边界与资源预算

| 来源 | 修复 | 为什么减负后仍需要 | 移植边界 |
| --- | --- | --- | --- |
| `f859a664` | 文件重命名拒绝路径分隔符、父目录穿越、控制字符与超长名称 | 桌面文件抽屉仍保留；此提交虽以 Web 审查命名，实际修的是共享文件服务 | `FileSystemService.ts` 与重命名行为测试 |
| `f859a664` | 宿主插件卸载验证请求来自受信任主窗口 | 宿主插件未列入本轮删除范围 | 只取卸载信任检查，不引入后续本地服务能力 |
| `51d1f7ba` 的一部分 | 普通文本读取默认 16 MiB，显式预算上限 64 MiB | 文稿材料、技能和提示词都继续使用文件读取 | `filesIpc.ts` 与大小护栏测试 |
| `51d1f7ba` 的一部分 | 粘贴写文件限制为 25 MiB | 文件附件和长文本粘贴继续保留 | `pasteFilesIpc.ts` 与粘贴回退测试 |
| `51d1f7ba` 的一部分 | 提示词元数据、技能正文改为句柄读取头部 64 KiB | 删除在线推荐不等于删除个人提示词和技能 | `PromptManager.ts`、`readSkillContent.ts` 与对应测试 |

上述预算是上游代码中的护栏值，不是本轮测得的内存占用。合入后仍应核查 TPA 材料读取调用是否需要显式预算和用户提示。

### B. 飞书、桌宠和终端的可靠性

| 来源 | 修复 | 价值 | 移植注意事项 |
| --- | --- | --- | --- |
| `51d1f7ba` 的一部分 | 飞书密钥不再按 Base64 字符形态猜测是否已加密 | 32 位字母数字密钥过去可能明文保存，重启时又被错误解码，导致认证失败 | 保留旧密钥格式读取兼容；新格式在 Electron `safeStorage` 可用时加密，不可用时仍有旧格式回退 |
| `51d1f7ba` 的一部分 | 飞书图片与附件流下载累计到 64 MiB 即中止 | 保留飞书后，应阻止超大资源一次性撑满主进程 | 保留原 50 MiB 文件使用限制，下载护栏不是扩大业务允许范围 |
| `51d1f7ba` 的一部分 | 飞书 `ws.start()` 的 Promise 拒绝有收口 | 网络握手失败不成为未处理异常 | 只验证模拟传输；合入后仍需真实机器人联调 |
| `51d1f7ba` 的一部分 | 桌宠移动、预览和终端输入的 IPC 类型检查 | 无效坐标或终端尺寸不应直接传入 Electron、ConPTY | 桌宠和终端均保留 |
| `2ee9e056` | 桌宠设置页预览尊重减少动效偏好 | 用户决定保留桌宠，适合同时保留这项小修复 | 只改变预览帧间隔，不承诺按比例减少整应用 CPU |
| `51d1f7ba` 的一部分 | Git 摘要生成子进程补 `error` 监听 | Pi 路径失效时不应崩主进程 | 保留原请求结算与清理语义 |

飞书配置目录的更名与延迟路径解析还出现在 `6e67c8c5`。宜保留延迟解析的时序修复；整目录迁移应与 TPA 自己的数据隔离方案一起决定，不直接套用 PiDeck 的迁移目的地。

### C. 会话关闭、发送和排队生命周期

这组是合并风险最高、同时也最值得保留的修复。

| 来源 | 修复 | 价值 |
| --- | --- | --- |
| `b20e032b` | 主进程惰性解绑推送 detach，界面收敛已消失的 Agent | 报错后的红点和「关闭 Agent」不再指向已经不存在的进程 |
| `5c3c1a7a` 的共享部分 | 停止运行时不再被在途 dispatch lease 挡住 | 提交标题虽是 ACP，`SessionRuntimeCoordinator` 的停止修复也服务 Pi；删 ACP 后仍要保留 |
| `51d1f7ba` 的发送与队列部分 | 停止响应后暂停自动排队投递；卸载、删除会话、换代时释放定时器和在途状态 | 用户已经停止的回合不应被队列自动续跑 |
| `51d1f7ba` 的发送部分 | 拒收恢复草稿、附件及引用；旧请求不覆盖新运行时 | 避免切栏、换代和失败时丢输入或恢复错会话 |
| `e9d577e6` | 命令层的复制与 fork 标题不被扫描竞态锁成旧正文 | 保留会话复制和分支功能后仍有价值 |
| `9a0449be` 的共享部分 | clone 与 fork 命令收口到桌面和 Web 共用层 | 若取后续 fork 修复，应核查这一依赖；Web 路由可删，共享命令层不应按标题一起删 |

这组应先同步自己的文稿主分支，再人工合并。不应用上游整个文件覆盖 `useSessionSend.ts`、`useQueuedPrompt.ts`、`AgentManager.ts` 或 `SessionRuntimeCoordinator.ts`。这些文件也承载需求对齐、文稿运行时身份与批准边界。

### D. 模型配置与上下文显示

| 来源 | 修复 | 宜 |
| --- | --- | --- |
| `081deae9` | 模型探测不再给不接受版本路径的协议自动补 `/v1` | 优先移植。否则探测成功也可能把 Anthropic、Mistral、Codex 或自定义协议的会话地址改坏 |
| `83a2545b` | 添加模型时只信官方目录的能力匹配，按家族归一化 | 宜移植，保留自定义配置语义；不应连同后续模型管理界面改版一起吸收 |
| `30271979` | 切换模型后立即发布新的上下文容量与使用快照 | 宜移植，防止界面仍显示旧模型的窗口容量 |
| `016d609a` | 「系统与工具」提示词装载统计使用实际会话快照 | 可作为第二批，带纯策略、状态字段、界面和测试一起移植 |
| `b4c23b06` | 在线版本查询失败仍保留本地扩展版本，错误写日志 | 宜移植。删除在线推荐后，本地扩展管理仍保留 |
| `7c4fc17a` | 异步 Pi 子代理终态落盘、任务描述合并 | 若保留 Pi 子代理则移植。ACP delegate 桥不等于应用的 ACP 后端，不应只因删除 ACP 后端而误删整个 Pi 扩展 |

`b4c23b06` 依赖此前扩展管理日志收口；不应假设每个宜提交都能独立 cherry-pick。

### E. 保留的生图与社区提示词库

共同基线到上游主分支的差异中，`src/main/imagegen/`、`XuePromptManager.ts` 和 `YaoPromptTab.tsx` 没有新增改动。它们目前不需要为了「更新版本」再合并一套实现。

`222f19ab` 是混合提交。宜只移植以下保留能力的修复：

- 生图输入框不展示无关的飞书、权限和会话模型控件。
- 已绑定但还未发送消息的草稿可以按定义切换后端。
- 草稿切到生图后回收本项目未认领的 Pi standby 进程。

生视频已改为保留，需连同任务提交、轮询、取消、下载、存储、IPC、界面和测试一起选择性接入。`222f19ab` 的媒体控件与 standby 修复应同时覆盖生图和生视频；ACP 常驻网关仍按长期复评结果决定。生图输入框隐藏飞书控件，不影响普通 Pi 会话继续连接飞书。

上游新增加的 `xuePromptLikeGate.test.mjs` 可保留为社区词库守卫；当前搜索本来已经在应用层解压 gzip 后匹配，不应把这项测试新增描述成缺失搜索修复。

### F. 打包与维护

`24138d05` 的 Electron Builder 解压 rename 有界重试，可在准备 Windows 打包时移植。它不应求重新引入 DSH 打包步骤。

自定义主题删除修复 `bb8a6d44`、日志清空后刷新 `cab3b485`、Git 摘要错误分类 `e89fa440` 也值得保留，但不必作为开始减负的前置条件。

## 暂缓或跳过的更新

| 更新 | 处理 | 原因 |
| --- | --- | --- |
| 生视频独立后端 `2867529a` 及专属测试 | 改为选择性接入 | 用户明确选择保留；接入应包含异步任务生命周期与媒体控件修复，不只增加创建入口 |
| Web 渲染、路由、重发和移动界面 | 跳过 Web 专属部分 | 用户已经决定删除 Web；共享文件安全与 fork 命令层另行保留 |
| ACP 恢复、取消请求、配置入口 | 跳过 ACP 专属部分 | ACP 将删除；通用停止与界面清理修复按保留能力判断 |
| DSH 插件归档和运行时修复 | 跳过专属部分 | DSH 将删除；共享文件、代理、Pi 安装能力不应随域名一起删除 |
| 遥测心跳 `80354bb1` | 跳过 | 遥测将删除 |
| 宿主插件本地服务控制与 billion-context 示例 `7dc243c7` | 暂缓 | 新增进程与权限面，不是现有核心修复 |
| 模型思考档位界面改版 `e8061625`、MCP 目录扩充 `48a2a203` | 暂缓 | 有使用价值，但扩大配置与测试范围，减负前不必同时改版 |
| Git 树视图、文件目录挂顶、功能提示轮播 | 暂缓 | 属于新体验，不应与可靠性修复捆成必合项 |
| 原版品牌统一和数据目录迁移 `6e67c8c5` | 不整提交吸收 | TPA 应独立确定身份和数据根，不应迁入原版 PiDeck 目录 |
| Logo 图片和显示名称自定义 `c6e60284`、`c9382caf` | 暂缓 | 显示名自定义不等于 appId、更新源或数据目录隔离 |
| 隐藏插件开发与桥扩展 `89ebf1cf` | 暂缓 | 当前桥已经默认关闭；入口隐藏与删除不是同一操作 |
| 发行通道切换修复 `b6b3c68e` | 单独评审 | 上游更新机制未列入本轮删除或移植决定 |
| 色板、模态键盘、设置索引、通知焦点 | 第二批再选 | 改善保留界面，但不是开始删除的必要条件 |
| Star history、致谢、官网和上游更新日志 | 不为减负合入 | 不增加个人工作台的核心能力 |

## 合并模拟结果

本轮使用 `git merge-tree` 模拟，没有执行 `git merge` 或 `git cherry-pick`，没有改变 HEAD、当前分支或暂存区。

整体模拟 `HEAD + upstream/main` 和 `origin/main + upstream/main` 均有 8 个文本冲突：

1. `resources/extensions/extensions-manifest.json`
2. `src/renderer/src/components/session/ComposerComponents.tsx`
3. `src/renderer/src/hooks/useComposerModeAvailability.ts`
4. `src/renderer/src/hooks/useQueuedPrompt.ts`
5. `src/renderer/src/hooks/useSessionComposerController.ts`
6. `src/renderer/src/hooks/useSessionSend.ts`
7. `src/shared/types/agent.ts`
8. `tests/sessionSendPromotionFailures.test.mjs`

无文本冲突的文件仍可能存在语义冲突。特别是主进程运行时事件、批准绑定和文稿恢复，需要合并后的行为测试。

以云端 `origin/main` 为目标，本轮还用各提交的父提交作为三方合并基线，模拟了 14 个候选补丁：

| 候选 | 文本模拟结果 | 说明 |
| --- | --- | --- |
| `f859a664`、`7c4fc17a`、`b20e032b`、`2ee9e056`、`e9d577e6`、`24138d05`、`081deae9`、`30271979`、`5c3c1a7a`、`bb8a6d44` | 无文本冲突 | 仍须裁掉混合提交中的删除域，补齐依赖并测试 |
| `51d1f7ba` | 5 个文件冲突 | session IPC、两个发送 hooks、fork 测试、发送提升测试；整提交还混入 Git 树视图和 DSH 修复 |
| `016d609a` | 2 个更新日志冲突 | 代码文本可合并；新状态字段与上下文统计仍需回归 |
| `b4c23b06` | 扩展管理器冲突 | 与先前日志收口存在上下文依赖，应按最终修复片段移植 |
| `222f19ab` | 5 个文件冲突 | 输入框、控制器和契约测试；生视频已选择保留，ACP 仍待长期复评 |

扩展清单应在最终合并后的 TPA 资源目录重新生成，保留需求对齐和文稿扩展。不应覆盖成上游清单；上游原本没有这些 TPA 扩展，这不等于上游主动删除了它们。

## 实施顺序与门禁

### 第一步：更新 TPA 基线

1. 保留当前锁文件修改和减负方案。
2. 将工作分支同步到自己的 `origin/main`。
3. 核对文稿、需求对齐及扩展清单，更新过时的减负前提。
4. 运行类型检查、对齐和文稿针对性测试。

### 第二步：移植必要修复

1. 移植文件边界、资源预算、飞书和 IPC 修复。
2. 移植协议地址修复与模型切换状态刷新。
3. 人工合并会话关闭、停止、发送与排队生命周期，保留 TPA 的批准和文稿边界。
4. 选择性接入生视频，并移植生图、生视频需要的控件与 standby 修复。
5. 按保留能力选择扩展终态、fork 标题和配置回退修复。
6. 重新生成扩展清单，并运行类型、格式和对应回归。

### 第三步：执行功能删除

先完成长期价值复评并收口最终范围，再按最终方案删除功能。公告与遥测仍属优先删除候选；Web、在线商店推荐、ACP、DSH 不因上一轮清单而直接进入代码删除。每域完成后检查 IPC、preload、设置、后台生命周期、旧数据和打包资源。

删除域的专属测试随行为移除；共享测试与 TPA 测试继续保留。最终运行全量测试、生产构建与完整桌面检查，不把隔离快照测试作为合并完成的证据。

## 调研期间的隔离验证（合并前）

本轮临时源码快照位于系统临时目录，不是当前分支的合并产物。快照使用现有 `node_modules` 的目录联接，没有执行依赖安装命令。

| 检查 | 本轮结果 | 证明范围 |
| --- | --- | --- |
| Git 版本、祖先和云端引用 | 完成 | v0.7.6 已包含；当前落后自己的云端主分支 |
| 上游 63 个非合并提交的文件清单 | 完成分类 | 识别新增功能、专属删除域和混合修复 |
| 整体合并与 14 个补丁模拟 | 完成 | 文本冲突和补丁上下文，不证明运行行为 |
| 上游快照 TypeScript 检查 | 通过 | 上游快照与现有依赖能通过类型检查，不是合入 TPA 后的类型检查 |
| 上游快照 33 个针对性测试文件 | 415 项通过，1 项跳过 | 文件、飞书、桌宠、提示词、终端、会话、模型、扩展和发送队列候选修复 |
| 自己云端快照 18 个针对性测试文件 | 169 项通过，0 项失败、0 项跳过 | 文稿与对齐的契约、批准、重复执行、普通改稿、运行时观察和存储边界 |
| 真实模型、完整 Electron、飞书服务、生图供应商、安装包 | 未验证 | 不声明实际服务和合并后的产品已验收 |

上游测试首次为 416 项：413 通过、2 失败、1 跳过。两项失败都要求 `git ls-files`，归档快照没有 Git 索引；为快照建立独立索引后，仅复跑对应两个文件的 6 项，全部通过。唯一跳过项是文件系统不允许创建符号链接的提示词边界用例。

本轮没有调用真实模型。测试中的 RPC 和服务由测试夹具替代。没有合并、提交、推送或删除用户数据；当前 `package-lock.json` 修改保持原状。

## 候选来源

- [共享文件安全修复](https://github.com/ayuayue/PiDeck/commit/f859a664c14ef4826943ccb67c78d1a772d86457)
- [可靠性与队列混合批次](https://github.com/ayuayue/PiDeck/commit/51d1f7ba4ba03e86f7a60a84b2ca9705903b55ce)
- [协议 baseUrl 修复](https://github.com/ayuayue/PiDeck/commit/081deae92b66f4449ffaf686f077b492827cf2c9)
- [模型切换后上下文刷新](https://github.com/ayuayue/PiDeck/commit/30271979c3a4690d8ab2712f61efb600988c2f20)
- [报错会话关闭修复](https://github.com/ayuayue/PiDeck/commit/b20e032bd77bd8a43ecd22dd85cac503a2f1af33)

## 全部非合并提交的取舍目录

下表保留提交原题。分类是本轮的取舍，不代表所有修复均已完成产品验收。

| 提交 | 原题 | 取舍 |
| --- | --- | --- |
| [d41be287](https://github.com/ayuayue/PiDeck/commit/d41be2878769b28f1ffbd905260c5938179042e3) | fix(ui): 底栏模式选择器去实心底与 chevron，普通模式图标改闪电 | 暂缓：输入框外观，保留 TPA 对齐布局 |
| [46022e86](https://github.com/ayuayue/PiDeck/commit/46022e86eb122487a64f9faac2bd11574f7bcafc) | fix(ui): 收敛计划/目标模式提示——去左侧竖条与独立退出按钮 | 暂缓：计划与目标模式提示外观 |
| [48a2a203](https://github.com/ayuayue/PiDeck/commit/48a2a2030623a3d8d6ef684d6ac977ed5118ce07) | feat(mcp): 目录新增 Tavily/Exa/腾讯文档/百度网盘/企查查并修正品牌图标 | 暂缓：MCP 目录扩充 |
| [f859a664](https://github.com/ayuayue/PiDeck/commit/f859a664c14ef4826943ccb67c78d1a772d86457) | fix(security): Web 端审查发现的输入加固——rename 纯文件名校验与 unmount 信任边界 | 优先：共享文件重命名与插件卸载信任边界 |
| [9a0449be](https://github.com/ayuayue/PiDeck/commit/9a0449be276a048d663ddd6a87793a8f69580f4d) | feat(web): fork/clone 统一命令层——桌面与 Web 同源，修 Web 重发后出现重复会话 | 拆取：共享 fork/clone 命令层，跳过 Web 路由 |
| [a739af3e](https://github.com/ayuayue/PiDeck/commit/a739af3e43213905fd6698d8ac9eb770fc79f74a) | feat(web): 重发/编辑 fork 化——与桌面端同语义,修 Web 端重复会话 | 跳过：Web 专属编辑与重发 |
| [60fc189d](https://github.com/ayuayue/PiDeck/commit/60fc189dc178d022d4b2082abce7e1751e78ee16) | chore: update star history [skip ci] | 跳过：上游统计图 |
| [a1d1b465](https://github.com/ayuayue/PiDeck/commit/a1d1b465e41c9bd3feb07e5a916e743e5c9ccac8) | fix(web): 渲染链路对齐桌面端——提升门控/外部流跨轮保活/可见性重开 | 跳过：Web 流式显示 |
| [ae3cf56d](https://github.com/ayuayue/PiDeck/commit/ae3cf56d442580882f6b2cff02dfdc63533deb2a) | fix(web): W3 加固批次——headersSent 防护/非法 JSON 400/静态根边界/属性转义/401 兜底 UX/i18n 补齐 | 跳过：Web 服务与静态页面加固 |
| [9c66fa0f](https://github.com/ayuayue/PiDeck/commit/9c66fa0febe9d9adb18d6ad10efb7ec7025346a7) | style: webServiceSessionRoutes keepAlive 契约测试过 biome 格式化 | 跳过：被删 Web 域的测试格式 |
| [51d1f7ba](https://github.com/ayuayue/PiDeck/commit/51d1f7ba4ba03e86f7a60a84b2ca9705903b55ce) | chore: 多 agent 并行批次收口——可靠性加固批次 + git 树视图 + 排队提示词生命周期 | 拆取：安全、飞书、资源预算和发送生命周期；暂缓 Git 树视图 |
| [1339debb](https://github.com/ayuayue/PiDeck/commit/1339debb07a6ff163dfd83e02a40f350232aa2a9) | test: piDeckMcpUi 契约断言适配上游 logoStyle 品牌切换（PiTuiLogoMark 形态也算原生 logo） | 按需：MCP Logo 契约，非核心修复 |
| [d935c9b7](https://github.com/ayuayue/PiDeck/commit/d935c9b78c3a632752cac8c26a1cfa0288339b3d) | fix(sidebar): 项目折叠黄点改用「会话在跑」口径 | 第二批：侧栏运行状态判据 |
| [8356cd88](https://github.com/ayuayue/PiDeck/commit/8356cd88e321853acf16f64829154c1cb90d3d5b) | fix(tabs): 取消切换会话 Tab 时的选中底色滑动动画 | 暂缓：Tab 选中动画 |
| [83a2545b](https://github.com/ayuayue/PiDeck/commit/83a2545b33bb9936ba21356e988e781324bd82f1) | fix(models): 添加模型的能力匹配只信官方目录，按家族归一化取值 | 宜：模型能力匹配 |
| [7c4fc17a](https://github.com/ayuayue/PiDeck/commit/7c4fc17a3dfef48d12bf2fd1850e9001f8b8484a) | fix(subagents): 异步子代理补持久终态，修「已完成仍显示运行中」 | 条件移植：保留 Pi 子代理时吸收终态修复 |
| [b20e032b](https://github.com/ayuayue/PiDeck/commit/b20e032bd77bd8a43ecd22dd85cac503a2f1af33) | fix(session): 修报错会话「关闭 Agent」失效，解绑推 detach 并补回菜单入口 | 优先：终态解绑、关闭与界面收敛 |
| [053d61d7](https://github.com/ayuayue/PiDeck/commit/053d61d77e086050561bad5ca13d257cd32df9a0) | fix: 20 色板 WCAG 对比度全量修复与守卫 | 第二批：主题对比度 |
| [b539f520](https://github.com/ayuayue/PiDeck/commit/b539f5201c76f2e7373a159ac7d39c72f2049bc3) | fix: 模态 Escape 与键盘可达性修复 | 第二批：模态键盘交互 |
| [72ec70ff](https://github.com/ayuayue/PiDeck/commit/72ec70ffcc3901948465b4721dab283afa3504c2) | feat: 文件抽屉目录行挂顶（对齐 VSCode sticky scroll） | 暂缓：文件抽屉目录挂顶 |
| [016d609a](https://github.com/ayuayue/PiDeck/commit/016d609a92ca36d90e364641d2ad85c69f0e2c6a) | fix(context): 圆环「系统 + 工具」改为实测提示词装载，修多供应商会话恒显 0 | 第二批：实际提示词装载统计 |
| [b4c23b06](https://github.com/ayuayue/PiDeck/commit/b4c23b06e4a14bec915333ea77a545e86b185609) | fix(extensions): 版本检查失败时保留本地已装版本，补齐失败原因日志 | 宜：本地扩展版本与失败日志；核查前置日志改动 |
| [322c4d28](https://github.com/ayuayue/PiDeck/commit/322c4d28a43f0a1a64ca0666ddc8f143dff68f78) | chore(extensions): 重新生成内置扩展清单（pi-deck-subagents.ts 哈希/体积） | 不直接复制：在 TPA 最终资源集重新生成清单 |
| [2867529a](https://github.com/ayuayue/PiDeck/commit/2867529aaaa5bd81eb41dad8486b7c545ae3cedd) | feat(videogen): 生视频独立后端——提交-轮询-下载异步任务链路 | 改为接入：用户选择保留生视频，核查完整任务生命周期 |
| [2ee9e056](https://github.com/ayuayue/PiDeck/commit/2ee9e056e755535eb71bee3ee49dcd553daf7b63) | fix(pet): 设置页桌宠预览画布尊重 prefers-reduced-motion（降到 1/4 帧率） | 宜：保留桌宠的减少动效修复 |
| [ebbac4cd](https://github.com/ayuayue/PiDeck/commit/ebbac4cd4d1cadce5409b383f27e172648a99df3) | test(videogen): 同步生视频后端引入后的契约测试锚点 | 改为接入：随生视频实现同步适用的契约测试 |
| [0616ee40](https://github.com/ayuayue/PiDeck/commit/0616ee401f2c0fac3362bf503ba8882d3bcd8de5) | docs(changelog): v0.9.0 补录生视频后端、扩展版本回退与桌宠动效条目 | 跳过：上游更新日志 |
| [89ebf1cf](https://github.com/ayuayue/PiDeck/commit/89ebf1cfd51df31f2d9409ad9e0c2db39d7301f4) | feat(extensions): 隐藏「插件开发」页签与桥/扩展点两个内置扩展 | 暂缓：隐藏开发与 GUI 桥入口 |
| [ff00c5de](https://github.com/ayuayue/PiDeck/commit/ff00c5de62e3769a31c4fe559b7c362fdfc2c147) | feat(settings): 会话状态位置默认改为输入框上方 | 暂缓：默认状态条位置 |
| [222f19ab](https://github.com/ayuayue/PiDeck/commit/222f19abdad1d201f3613f0abbc33af705e1eacc) | fix(composer): ACP 入口立即可用、生图/生视频屏蔽无关控件、未发消息可换后端 | 拆取：生图、生视频输入框与 Pi standby 回收；ACP 待复评 |
| [57634203](https://github.com/ayuayue/PiDeck/commit/57634203c866798f060d2975b6cc4ded3fa7c9a6) | docs: 致谢名单与 v0.9.0 更新日志补充罪、橙子 | 跳过：上游致谢 |
| [80354bb1](https://github.com/ayuayue/PiDeck/commit/80354bb14fbe104e3b33dc3429f3651a560a4c07) | fix(telemetry): 心跳等项目表加载完成再上报，projects_total 不再恒为 0 | 跳过：遥测将删除 |
| [af9018e2](https://github.com/ayuayue/PiDeck/commit/af9018e290aa18a5cc19eb842fd0eb51c0cd5ac8) | chore: update star history [skip ci] | 跳过：上游统计图 |
| [e9d577e6](https://github.com/ayuayue/PiDeck/commit/e9d577e60a08c0641012778d826e6f5700e995ba) | fix(session): 复制/fork 产物标题被扫描竞态锁成正文兜底——命令层写入的 (fork) 名不再丢 | 宜：fork/复制标题与扫描竞态 |
| [20fdfcf4](https://github.com/ayuayue/PiDeck/commit/20fdfcf4053194b286e747620a5d8bc59bae06d0) | fix(settings): Ctrl+P 补全设置索引，新增分区级搜索锚点 | 第二批：设置搜索索引；删除入口后按 TPA 重建 |
| [18331345](https://github.com/ayuayue/PiDeck/commit/18331345603760a6410bdd061f352641d1b958d2) | chore: update star history [skip ci] | 跳过：上游统计图 |
| [e8061625](https://github.com/ayuayue/PiDeck/commit/e8061625d146476e534192a2c0ba2ad8b5c0f5f4) | feat(config): 思考档位改勾选编辑——两条供应商入口对齐、设置跟随模型列表 | 暂缓：模型配置界面改版 |
| [24138d05](https://github.com/ayuayue/PiDeck/commit/24138d054d18c5d5fed95525f3bace750181269a) | fix(build): Windows 打包解压 electron dist 的 rename 偶发 EPERM——postinstall 注入有界重试 | 打包前宜：Windows rename 有界重试 |
| [cab3b485](https://github.com/ayuayue/PiDeck/commit/cab3b4854e68519451dfef76d93a334f1edff4bb) | fix(settings): 应用日志删除后查看器立刻换新，不再需要手动刷新 | 第二批：日志清空刷新 |
| [b6b3c68e](https://github.com/ayuayue/PiDeck/commit/b6b3c68e99ff875e59e4d60811c973ba047cba27) | fix: 通道切换回退旧开发版——版本比较补全预发布语义并加目标版本守卫 | 单独评审：更新通道机制 |
| [39552c6d](https://github.com/ayuayue/PiDeck/commit/39552c6d10757f9d40518fca62ef1628b6ca5598) | fix(acp): 重开历史会话时恢复 agent 侧会话与历史重放 | 跳过：ACP 后端历史恢复 |
| [defd6841](https://github.com/ayuayue/PiDeck/commit/defd6841b2106842cde1f0685990b9d3a8a2eeea) | feat(notifications): 通知按窗口焦点门控，标题与图标改用品牌资源 | 第二批：通知焦点门控与图标 |
| [07e905f5](https://github.com/ayuayue/PiDeck/commit/07e905f50115ce4f86e4662d1b041cb888c9e948) | feat(session): 流式状态条右侧轮播功能提示 | 暂缓：功能提示轮播 |
| [383eb5cd](https://github.com/ayuayue/PiDeck/commit/383eb5cd4d9987e9312e1ca6a3b3ad72c7166831) | fix(preview): 预览 mock 补 alertOnlyWhenUnfocused 默认值 | 按需：随通知焦点修复同步预览默认值 |
| [5c3c1a7a](https://github.com/ayuayue/PiDeck/commit/5c3c1a7abe6dfbbcf2c8fc099d8dd6884faf3eb5) | fix(acp): 回合超时补发 session/cancel，停止不再被在途 dispatch lease 挡住 | 拆取：通用 stop 越过在途 lease；跳过 ACP 请求取消 |
| [bb8a6d44](https://github.com/ayuayue/PiDeck/commit/bb8a6d441a97c30a76a14eb94810e4cb51b99cce) | fix(themes): 自定义主题删除按文件主键生效、编辑器弹窗按视口限高 | 第二批：自定义主题删除与弹窗限高 |
| [430783e8](https://github.com/ayuayue/PiDeck/commit/430783e8105c183e1eb8612f9ab027f95362b911) | fix(session): ACP 首启失败回收草稿时清空选中，不再落到空态面板 | 按需：删除 ACP 后核查共享失败选择清理 |
| [8e0bc4db](https://github.com/ayuayue/PiDeck/commit/8e0bc4db6b09808fc6ef9eb4e35a8a5d31874f39) | fix(i18n): 补 PR #336 的 zh-TW 繁体词条，恢复 typecheck 绿灯 | 按需：只同步选中修复的繁体词条 |
| [081deae9](https://github.com/ayuayue/PiDeck/commit/081deae92b66f4449ffaf686f077b492827cf2c9) | fix(config): 探测补齐的版本路径不再改写不吃版本段的 baseUrl | 优先：协议 baseUrl 改写策略 |
| [3f016ad5](https://github.com/ayuayue/PiDeck/commit/3f016ad504ddc8d505b4e7a07f2ef24ecea85ff5) | docs: v0.9.0 更新日志补全新功能/改进/修复，并致谢与收录贡献者 | 跳过：上游更新日志 |
| [30271979](https://github.com/ayuayue/PiDeck/commit/30271979c3a4690d8ab2712f61efb600988c2f20) | fix: refresh context usage after switching session models | 宜：切模型后的上下文容量刷新 |
| [e89fa440](https://github.com/ayuayue/PiDeck/commit/e89fa44058d331cb61d03a811522d67ea12f8b15) | fix(git): 提交摘要区分「暂存区为空 / 无仓库 / 读 diff 失败」，不再误报模型设置 | 第二批：Git 提交摘要错误分类 |
| [6e67c8c5](https://github.com/ayuayue/PiDeck/commit/6e67c8c5658a9d01f1a94c8898200da56d1036db) | fix: unify PiDeck branding and migrate legacy data directories | 不整合：独立设计 TPA 身份与数据隔离；拆取共享时序修复 |
| [eb20763d](https://github.com/ayuayue/PiDeck/commit/eb20763d085f67cf7b7f161567c28c4470649937) | test(i18n)+docs: 加 zh-TW 源指纹门禁，拦住「只改值不重跑」的静默滞后 | 第二批：繁体词条生成与指纹门禁 |
| [7dc243c7](https://github.com/ayuayue/PiDeck/commit/7dc243c7445b42fd552366975956ab798f891acd) | feat(host-plugins): 内置 billion-context 示例插件，新增受限本地服务启停能力 | 暂缓：宿主插件新本地服务权限与示例 |
| [65e01858](https://github.com/ayuayue/PiDeck/commit/65e018588e9f38423c0f1bd5e1b481543b1b89c3) | fix(ci): 修 main 红灯——格式漂移 + 两处过期源码契约断言 | 按需：选中能力的格式与契约维护 |
| [14f8c82e](https://github.com/ayuayue/PiDeck/commit/14f8c82eb9a21d4275b0d8b12ea90bfb557f470f) | fix(host-plugins): 修内置示例面板与浏览器入口，补卸载与停止语义 | 暂缓：新示例插件生命周期；现有卸载安全另取 |
| [c6e60284](https://github.com/ayuayue/PiDeck/commit/c6e60284eb6a49933cc484dd1800195da8a78dbe) | feat(branding): Logo 支持自定义图片与应用显示名称 | 暂缓：Logo 和显示名称自定义 |
| [c9382caf](https://github.com/ayuayue/PiDeck/commit/c9382caf021b39a163432d133cb6786b13ea275d) | feat(branding): 任务栏标题与启动开屏跟随自定义品牌 | 暂缓：跟随自定义品牌的开屏与标题 |
| [935b40e3](https://github.com/ayuayue/PiDeck/commit/935b40e34dd64f175025887234df670f73c54f26) | test(sessions): WSL 扫描超时用例不再因 watchdog 提前触发而挂死 | 按需：保留 WSL 时可吸收稳定测试夹具 |
| [a1c216f8](https://github.com/ayuayue/PiDeck/commit/a1c216f81deb02fe740dad7212969e3840595052) | style(host-plugins): 插件列表操作改「更多操作」下拉菜单 | 暂缓：插件列表菜单外观 |
| [1dca7b95](https://github.com/ayuayue/PiDeck/commit/1dca7b95bde0f1ae81c888d454383a5544d60e1d) | test(renderer): 开屏内联脚本 stub 补齐 DOM 能力，修品牌自定义带来的 2 个红灯 | 按需：采用品牌功能才同步开屏测试 |
| [a8e38e8c](https://github.com/ayuayue/PiDeck/commit/a8e38e8ca8e47dcccf0d5542fe60a268b8dd4831) | chore: update star history [skip ci] | 跳过：上游统计图 |
