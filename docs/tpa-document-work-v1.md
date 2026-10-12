# TPA 文稿执行、成果归档与改稿方案

状态：首版源码与单元测试已落地（实现 B）；真实模型文稿链路与完整桌面联调待验证。日期：2026-10-12。

本方案定义 TPA 独立完成正式文稿的首版范围、模块接口和验证要求。首版已按此方案实现，验收记录见文末「实施记录」；本次不启动数据迁移。

## 1. 目标与范围

用户在 TPA 的同一段聊天里提供材料、确认要求、取得初稿和提出修改。TPA 自动保存实际成果和版本。用户不必创建任务、选择基稿或点击存档。

正式文稿在 TPA 当前 Pi 会话中执行。TPA 自己保存工作记录与成果，不调用 Workbench 服务、执行器或 MCP。退出 Workbench 后，整条文稿流程仍可使用。

首版覆盖新建 Word、修改已有 Word，以及配套 Markdown 源稿。普通聊天和项目开发继续沿用原流程。Excel、PPT、跨设备执行及旧工作台档案迁移留到后续。

### 用户体验

1. 用户开启需求模式并提交第一条实际要求。TPA 建立工作记录；空模式不建记录。
2. Pi 读取材料，默认用 anydoc 转换文档。转换失败时如实说明。
3. 用户在聊天里确认当前要求。Pi 在当前会话直接制作。
4. TPA 自动归档初稿、可编辑源稿、材料引用和检查结果。
5. 用户提出改稿要求。TPA 确定基稿并提供本次修改上下文。
6. Pi 修改实际基稿并另存新版。TPA 检查变化并在聊天里汇报。
7. 用户重开 TPA。TPA 恢复工作与成果关联，不自动重放执行。

明确的局部改稿指令可作为本轮授权，不再重复询问相同内容。修改对象、范围或保留要求不明确时，先澄清。用户主动要求重新对齐时，复用原确认单。

### 完成标准

- Workbench 未启动时，TPA 可独立完成材料读取、初稿、改稿和恢复。
- 初稿和新版均自动保存到用户指定目录，旧版保留。
- 需求模式结束后，工作关联仍存在；普通聊天中的改稿可继续关联成果。
- 多份成果或多件工作存在歧义时，TPA 不按标题或文件时间猜测。
- 程序检查、模型汇报和用户认可分别记录。

## 2. 当前能力与增量

以下现状已在 2026-10-12 核对源码；不代表真实文稿链路已经验收。

| 能力 | 当前实现 | 本方案增量 |
| --- | --- | --- |
| 对齐与批准 | 聊天内确认；绑定 `briefId + revision` 和运行时身份 | 将确认绑定到本次文稿执行准备记录 |
| Pi 执行 | `SessionRuntimeCoordinator` 沿用标准 RPC | 复用同一会话，不增加模型执行器 |
| 材料转换 | 当前对齐扩展禁用全部 `bash` | 放开命令以调用 anydoc，沿用原有权限 |
| 成果归档 | 对齐完成不等于成果登记或检查通过 | 新增 TPA 成果域、版本记录和检查 |
| 改稿 | 当前无 TPA 文稿基稿与版本服务 | 自动确定基稿、保留副本、另存和比较 |
| 恢复 | 已有 Pi 会话历史与运行时恢复 | 恢复工作关联，查询原操作，不重复执行 |

可参考 Workbench 的转换缓存、版本记录和请求去重设计。移植的代码应放进 TPA 自身模块，移除 Workbench 路径、端口、配置和档案依赖。不修改 Workbench 源码。

当前对齐实现见 [需求对齐首版](tpa-alignment-v1.md)。长期方向见 [长期改进路线](tpa-roadmap.md)。

## 3. 架构与数据归属

Pi 负责模型、工具调用和原生会话文件。TPA 主进程负责文稿元数据、文件归档和程序检查。渲染层负责聊天呈现和事件转发。

| 模块，均为拟新增 | 单一职责 |
| --- | --- |
| `src/shared/types/documentWork.ts` | 共享输入、输出、事件和版本类型 |
| `src/shared/documentWork.ts` | 有界协议解析和版本校验，不依赖运行时 |
| `src/main/document-work/DocumentWorkService.ts` | 工作创建、准备、分发和结算 |
| `DocumentWorkStore.ts` | 持久化、记录版本检查和请求去重 |
| `DocumentArtifactStore.ts` | 基稿副本、文件指纹和成果归档 |
| `DocumentRevisionPolicy.ts` | 基稿选择、授权及修改范围纯策略 |
| `DocumentInspectionService.ts` | 注册式格式检查、正文比较和预算控制 |
| `DocumentWorkRuntimeAdapter.ts` | 对接现有会话协调器与 RPC 事件 |
| `src/main/ipc/documentWorkIpc.ts` | 输入校验和服务适配 |
| `resources/extensions/pi-deck-document-work.ts` | Pi 内工作绑定、成果候选汇报和会话事件 |
| `resources/extensions/pi-deck-document-materials.ts` | 在 Pi 工具内调用 anydoc，校验材料指纹和转换缓存 |
| `src/renderer/src/atoms/document-work-atoms.ts` | 按 `sessionId` 保存界面投影 |
| `src/renderer/src/hooks/useSessionDocumentWork.ts` | 聊天交互状态、订阅和错误反馈 |

上述主进程文件均放在 `src/main/document-work/`。按职责拆分，单文件目标不超过 400 行。`main/index.ts`、`App.tsx`、`AgentManager.ts` 只增加装配或薄转发。

### 通信边界

- Renderer 经 preload 和 IPC 调成果域，不访问 Node 或文件系统。
- Main 与 Pi 只走既有 stdio JSON-RPC。工作上下文经已有 prompt/注册命令传入；汇报经已有消息事件返回。
- 不添加 HTTP、WebSocket、MCP、SDK 侧车或共享文件轮询通道。
- 不扩展 GUI 桥用途。主进程不调用第二个模型，不代写 Pi JSONL。
- 新扩展纳入现有资源分发、逐文件清单和禁用机制。扩展不可用时，禁用托管文稿入口并说明原因，普通聊天可继续。

运行时 adapter 的事件订阅、检查 worker、转换子进程和超时计时器均应在所属模块提供配对清理。停止、换代、删除会话和退出时清理；已归档记录不随退订删除。

### 持久化

TPA 在独立 `userData/document-work/` 保存工作、操作和准备记录。该目录是文稿元数据事实源；Pi 原生会话仍是对话事实源。

用户指定的成果目录应经显式选择和路径校验，登记为本功能允许的项目根。TPA 为每件工作创建稳定目录，再按版本创建独立子目录。标题只用于可读名称，身份由程序生成。

每版归档保存实际文稿、存在的可编辑源稿、生成脚本或模板引用、基稿身份及检查结果。不承诺存在未生成的源稿，也不靠重新调用模型恢复旧稿。

归档时另存原始字节快照到 TPA 管理的快照目录，并记录指纹。用户可编辑成果目录中的公开文件；发现手改时，以快照保留归档当时的旧稿。正常流程不改快照，快照损坏时如实报告。文件相同可按指纹复用，降低重复存储。

版本采用 `staging/<attemptId>/`、`versions/v0001/` 的分区。Pi 在本次 staging 内制作；TPA 在结算时验证并复制到新版本。版本目录创建使用排他语义，目标已存在时不覆盖。

程序正常归档路径不覆盖旧版。开放 `bash` 后，这不等于操作系统禁止任意命令修改旧文件。首版保留该边界，不宣称提供强制沙箱。

## 4. 数据模型与状态

| 对象 | 核心字段与规则 |
| --- | --- |
| `DocumentWorkRecord` | `schemaVersion`、`workId`、`sessionId`、`revision`、原话来源、确认要求、输出根标识、活动操作和版本列表 |
| `DocumentWorkOperation` | `requestId`、请求摘要、`attemptId`、操作种类、准备身份、运行时身份、分发状态与错误；先持久化再分发 |
| `DocumentWorkPreparation` | `preparationId`、工作版本、要求版本或用户指令来源、材料指纹、基稿指纹、修改范围、输出位置；内容不可变 |
| `DocumentArtifactVersion` | 稳定 `versionId`、递增显示序号、父版本、实际文件和 SHA-256、源稿引用、模型汇报、检查与用户认可 |
| `DocumentInspection` | `passed / failed / unverified`、检查项、覆盖范围、字节预算、耗时、原因和检查器版本 |

工作记录的 `revision` 只用于并发写入检查；成果显示序号与 Pi 要求 `revision` 不混用。稿件正文、图片和 base64 不写入元数据或 Pi 结构化汇报。

操作状态为 `prepared → dispatching → running → inspecting → archived`。失败、中断和不确定分发分别记为 `failed`、`interrupted`、`unknown`。

`archived` 只表示文件和记录已保存。版本的程序检查另有 `passed / failed / unverified`；用户认可默认为 `not_collected`。检查失败的新版保留，但不自动成为下次默认基稿。

下一轮默认基稿取“本件工作最近成功归档、文件可读取、所需检查通过”的版本。用户明确指定版本时优先采用该版本。缺少可用版本或存在多个对象时返回歧义，不采用目录中最新文件。

## 5. 对外接口契约

本节的“对外”指模块调用者、Renderer IPC 和 Pi 扩展协议，不发布网络 API。接口名为实施约定，当前尚不存在。

### 公共类型

```ts
type WorkMutation = {
	requestId: string;
	workId: string;
	expectedRevision: number;
};

type PreparationReference = {
	preparationId: string;
	digest: string;
};

type RequirementsReference =
	| { kind: "alignment"; briefId: string; revision: number }
	| { kind: "user_instruction"; sourceTurnId: string };

type AuthorizationReference =
	| { kind: "alignment_confirmation"; briefId: string; revision: number }
	| { kind: "revision_instruction"; sourceTurnId: string };

type PreparedWork = {
	workId: string;
	workRevision: number;
	preparation: PreparationReference;
	summary: string;
};

type WorkErrorCode =
	| "INVALID_INPUT" | "WORK_NOT_FOUND" | "REVISION_CONFLICT"
	| "IDEMPOTENCY_CONFLICT" | "RUNTIME_CHANGED" | "RUNTIME_BUSY"
	| "PREPARATION_STALE" | "APPROVAL_REQUIRED" | "BASE_AMBIGUOUS"
	| "BASE_CHANGED" | "PATH_DENIED" | "EXTENSION_UNAVAILABLE"
	| "DISPATCH_UNKNOWN" | "INSPECTION_UNVERIFIED" | "IO_ERROR";

type WorkResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: { code: WorkErrorCode; retryable: boolean; currentRevision?: number } };
```

ID 为程序生成的有界非空字符串；`expectedRevision` 为非负安全整数。错误文案在 Renderer 经 i18n 映射；日志不输出令牌、隐私正文或原始协议载荷。

`requirementsRef` 和 `authorization` 分别采用上述引用类型。主进程从原会话或权威对齐投影核对来源，拒绝 Renderer 或模型伪造的批准事实。改稿指令与普通讨论不能仅凭“第二节”等关键词区分；不能确定制作意图时先澄清。

### IPC / `desktopApi.documentWork`

| 方法与通道 | 输入 | 输出与行为 |
| --- | --- | --- |
| `create` / `document-work:create` | `requestId, sessionId, sourceTurnId, title, outputRootId` | 工作记录；来源限定为本会话实际用户消息，不启动制作 |
| `get` / `document-work:get` | `workId, sessionId` | 有界工作快照，不读取全部文稿正文 |
| `prepare` / `document-work:prepare` | `WorkMutation, kind, requirementsRef, feedbackSourceTurnId?, baseVersionId?` | `PreparedWork`；返回保存后的工作版本，规范化修改范围、冻结实际基稿，不调模型 |
| `start` / `document-work:start` | `WorkMutation, preparation, expectedRuntime, authorization` | 持久操作记录；复核授权后经原 RPC 分发到当前 Pi |
| `getOperation` / `document-work:operation` | `requestId, sessionId` | 原请求的分发、运行和检查结果；未知结果不重新制作 |
| `cancel` / `document-work:cancel` | `WorkMutation, attemptId, expectedRuntime` | 仅通过原协调器取消匹配的运行，不取消其他会话或轮次 |
| `onChanged` / `document-work:changed` | 订阅 | `workId, sessionId, revision, attemptId?, changeKind`；preload 返回退订函数 |

`kind` 只允许 `create_document` 或 `revise_document`。`authorization` 是当前要求的明确确认或本次明确改稿指令引用；模型文本和布尔字段不能授予授权。

保存操作返回最新工作 `revision`。调用者应使用该版本提交下一次修改，不能继续用准备前的版本。只读接口不改变记录版本。

接口只接受输出根、版本和准备记录的 ID。Renderer 不提供绝对输出路径、命令、成果状态或检查结论。材料路径沿用现有用户文件选择与授权校验，主进程解析真实路径后检查边界。

新增 IPC 时同步更新 `shared/ipc.ts`、主进程 handler、preload 白名单和共享 API 类型。`start` 在每次异步步骤后重新核对 `SessionRuntimeTarget`。

### Pi 扩展输入与输出

主进程经既有发送接口调用注册命令 `/tpa-work bind <payload>`。命令只绑定上下文，不触发模型回合。`payload` 是有界 base64url JSON，含 `schemaVersion, workId, attemptId, preparationId, digest, sessionId` 和本轮材料、基稿、输出及范围信息；解码后上限为 64 KiB。

扩展确认绑定后，经隐藏 `custom_message` 发布 `customType: tpa-document-work-state`，返回绑定身份。主进程收到匹配确认后，才允许既有对齐批准触发制作。明确改稿则经同一发送路径提交绑定的用户要求。

扩展和对齐模块共享一个明确的工作绑定入口。对齐批准产生的执行上下文应携带本次绑定；不靠两条相邻普通聊天消息的顺序猜测。旧 `/align approve` 保持兼容，未启用文稿功能时行为不变。

Pi 工具 `tpa_artifact_report` 只发布候选信息：`schemaVersion, workId, attemptId, preparationId, digest, reportId, artifacts, editableSources, summary, risks`。文件用本轮 staging 下的相对路径。汇报上限为 64 KiB、32 个文件、单个路径 1024 字符。

模型汇报不能创建操作、批准执行或判定检查通过。扩展把候选记录持久化到 Pi 活动分支，并通过原 RPC 消息发布；主进程独立验证身份和文件。历史恢复可补登记匹配的未结算汇报，不恢复执行授权。

工具执行成功或 `agent_end` 都不是归档完成。主进程等待现有 `agent_settled` 或权威 idle 判据，并确认无排队输入、压缩或重试后，再检查候选。迟到候选不能绑定到新运行。

材料工具 `tpa_read_material` 接收绑定工作中的 `materialId`，不接收任意命令和输出路径。Pi 扩展用固定 argv 调用 anydoc，在允许缓存目录保存 Markdown，并返回来源指纹、转换结果和读取摘要。TPA 通过原 RPC 接收该结果。普通 `bash` 仍按原权限可用，但不能仅凭模型说“已转换”写入成功的转换记录。

## 6. 核心执行与改稿逻辑

### 单次确认

TPA 在最终确认时绑定实际准备记录。绑定包括要求版本、材料、基稿、修改范围和输出位置。准备期间要求变化或运行时替换时，旧准备失效。

主进程先持久化请求和准备身份，再经原 RPC 绑定及分发。RPC 接受仅表示接收；扩展批准和运行信号分别记录。主进程不把按钮点击或模型口头答复当作批准成功。

首次制作复用聊天确认单，不添加第二个执行审批页面。改稿指令授权仅覆盖该指令；扩大范围、矛盾的保留要求或基稿歧义仍需澄清。

### 基稿和手工修改

1. 根据工作关联和显式版本选择基稿。
2. 检查实际基稿 SHA-256，不只检查时间或大小。
3. 如果文件变化，保留已归档副本，并登记外部修改版。
4. 如果修改版归属唯一且没有范围冲突，自动采用新基稿。
5. 如果出现冲突或不能确定内容，保留输入并返回澄清结果。
6. 制作本轮冻结副本，校验复制前后指纹；复制中变化则重试有界读取或返回 `BASE_CHANGED`。

执行期间原文件再次变化时，新稿仍标明采用哪份冻结副本。TPA 不覆盖原文件，也不宣称新稿包含复制后的手工修改。

已有 Word 的改稿应在副本上局部修改。anydoc 用于理解材料，不用 Markdown 重建已有 Word 来冒充保真修改。由源稿生成的文稿应登记生成方式；手工改过 Word 后，不沿用过期源稿覆盖手改内容。

### 文件登记和防覆盖

主进程校验相对路径、真实路径和允许目录，拒绝绝对路径、`..`、符号链接或 junction 逃逸。候选文件应是预算内的非空普通文件。

TPA 从 staging 复制到新版本目录，并校验归档字节与登记指纹一致。文件写入和元数据保存采用可恢复提交记录；中途失败保留 staging 与输入，不报告归档完成。

同一工作同时只分发一个制作操作；并发准备或改稿通过工作版本检查拒绝。不同工作若共享同一 Pi 运行时，沿用其忙碌和队列规则，不偷偷并行。

### 请求去重与恢复

同一 `requestId` 和相同输入返回原操作。相同 ID 携带不同输入返回 `IDEMPOTENCY_CONFLICT`。冲突后不自动换 ID 再执行。

`dispatching` 时断线或重启，先查询原运行和 Pi 活动分支记录。无法证明是否已执行时记 `unknown`，不自动重放。不承诺跨崩溃 exactly-once 模型执行。

关闭窗口后是否继续运行沿用 PiDeck 生命周期。整应用退出会清理其 Pi 进程；重开不表示后台已完成。已归档版本恢复，未完成操作核对后记运行、中断或未知。

旧版或损坏的文稿元数据应保留原文件，停止该记录的写入并返回结构化错误；不伪造缺失字段。新格式带 `schemaVersion`，迁移在副本上验证后替换。正常旧 Pi 会话可打开，首版不批量改写历史。

## 7. 程序检查与速度预算

文件指纹判断字节是否变化；正文比较判断修改位置；渲染检查判断分页和外观。三类结果分别记录，不相互替代。

首版正文比较覆盖可定位的章节、段落及表格文字。范围策略形成显式允许修改块与保留块。标题重复、未解析修订、无法定位的文本框或其他未覆盖结构返回 `unverified`，不默认判通过。

Word 格式、图片、页眉页脚等采用分项检查。普通正文未变不等于排版未变。需要正式排版验收时，执行器另行渲染并核对；检查结果只说明实际覆盖的内容。

未授权文字变化时，检查记 `failed`，保留候选版本并说明具体位置。没有对应检查器或超预算时记 `unverified`，不自动修复、不冒称“其他部分完全未变”。

| 项目 | 首版设计预算，不是已测结果 |
| --- | --- |
| 成果文件 | 单文件 32 MiB；超过预算只保存文件存在证据，检查记未验证 |
| OOXML 解包 | 解压总量 64 MiB、单 XML 8 MiB、部件数 10000；拒绝实体声明和重复部件 |
| 快速检查目标 | 本地文件不超过 10 MiB、正文不超过 20000 段时，指纹与结构比较 p95 不超过 1 秒 |
| 结构检查时限 | 2 秒；超时终止检查任务，保留成果并报告未验证 |
| 转换时限 | 120 秒；新材料单独显示转换状态，扫描 OCR 不计入快速检查目标 |
| 并发 | 同一工作 1 个制作操作；检查和转换各不超过 2 个后台任务 |

转换缓存键包含原件 SHA-256、转换器版本和输出校验。原件未变时复用缓存；原件在转换中变化则拒绝采用结果。不每次转换所有历史材料，也不每次让模型复审全文。

结构比较在后台 worker 执行，不阻塞 Electron 主线程。性能验收记录设备、文稿规模、冷热缓存及样本数；超过目标时先缩小覆盖或改进算法，不放宽正确性结论。

## 8. 需求模式权限与失败降级

取消对齐阶段额外施加的全部 `bash` 禁用，沿用用户的 Pi 权限配置。扩展提示词区分“读懂材料”和“正式制作”。正式制作入口继续绑定当前授权。

开放命令不等于新增沙箱。任意 shell、第三方扩展或外部终端可能绕过正常流程；程序只保证受控入口的行为，不保证所有命令无副作用。不照搬现有 Plan 正则作为安全保证。

首版允许 Pi 根据用户指令调用 anydoc；转换结果和失败信息经工具及会话返回。TPA 不增加第二条转换执行通道，不在材料尚未读到时宣称已读。

功能开关允许停止新托管文稿操作，已存版本仍可读取。执行中不热撤销操作上下文；取消或完成后再关闭新入口。旧普通会话无需迁移，也不因缺少成果记录而受阻。

## 9. 单元测试要求

新增对外接口和核心逻辑应有单元测试。界面布局、样式、简单赋值和原样字段转发不单独新增测试；现有测试不删除或放宽。

测试从公开函数、服务接口、IPC 边界或扩展协议断言行为。不用源码正则代替行为测试，不依赖真实网络、真实模型、Electron 窗口或 Pi 进程。

| 测试文件，均为拟新增 | 应验证的行为 |
| --- | --- |
| `documentWorkContract.test.mjs` | 输入形态、长度和预算；损坏/未知协议版本；结构化错误；main 与扩展字段一致 |
| `documentWorkIpc.test.mjs` | 会话归属、未知 ID、路径注入拒绝；版本冲突；未授权制作拒绝；错误不抛裸异常 |
| `documentWorkStore.test.mjs` | 原子保存失败、重启恢复；相同请求返回原结果、不同输入冲突；并发修改只成功一次；旧格式迁移或损坏记录不丢失 |
| `documentWorkService.test.mjs` | 准备失效；批准绑定实际版本；异步期间 runtime 替换；忙碌/队列拒绝；未知分发不重复调用 RPC |
| `documentWorkRuntimeAdapter.test.mjs` | 绑定确认匹配；模型汇报不批准；旧 attempt/会话/运行时代际拒绝；重复汇报不重复归档；`agent_end` 不结算 |
| `documentArtifactStore.test.mjs` | 基稿复制中变化；归档中变化；目标存在不覆盖；符号链接/junction 逃逸；提交中断后可恢复 |
| `documentRevisionPolicy.test.mjs` | 默认可用基稿、显式历史稿、多对象歧义；手改接续与冲突；未授权段落变化；全篇修改的明确授权 |
| `documentInspection.test.mjs` | 文件可读性、正文/格式分项；正文相同而 ZIP 字节不同；同长度文字变化；复杂结构未验证；超时/超预算不判通过 |
| `documentMaterialCache.test.mjs` | 材料 ID 和缓存路径校验；固定 argv 不经过 shell；未变缓存命中、转换器变化、损坏缓存、转换中原件变化、失败不标已读 |
| `documentWorkRecovery.test.mjs` | Pi 活动分支补登记；未确认工作不启动；结果缺失为未知；档案失败保留输入；扩展关闭时不破坏普通聊天 |

会话 hook 若新增请求失效、确认等待或队列状态流转，应补行为测试。单纯订阅赋值和视图 props 不重复测试服务实现。

修 bug 时先写失败复现，再修到绿。生产 TS 用 `tests/helpers/loadTsCommonJs.mjs` 或 `createTsSandbox.mjs`；时间、RPC、存储和检查器通过依赖注入替换。文件行为使用独立临时目录，失败样本永久保留在测试夹具中。

布局和简单赋值不新增单元测试，不代表免除体验验收。实际操作验证聊天确认、普通聊天改稿、重开恢复、亮暗主题和窄栏可读性；不为布局新增截图快照套件。

## 10. 分步实施与合并门禁

| 步骤 | 交付与门禁 |
| --- | --- |
| A：接口与档案 | 完成共享契约、Store、路径安全和请求去重；契约/IPC/Store 单元测试通过 |
| B：读取与准备 | 放开需求模式命令；实现基稿冻结、材料指纹和准备失效；权限边界如实说明 |
| C：同会话制作 | 接通扩展绑定、原批准及分发；候选汇报、settled 判据和原子归档；无 Workbench 依赖 |
| D：改稿与检查 | 完成自动基稿、手改接续、另存和范围比较；失败/超预算样本不产生假通过 |
| E：恢复与体验 | 恢复工作关联和操作结果；扩展关闭、服务失败、应用退出后的行为可判断 |
| F：真实验收 | 在 Workbench 未启动时，用隔离材料完成初稿、第二稿和重开继续；记录速度与检查覆盖 |

每步记录能力是否保留：普通聊天、原需求确认、原权限、Pi 会话历史、项目开发、扩展关闭均不受破坏。进入后一步前，前一步的类型检查和针对性测试应全绿。

实施后的门禁命令：

```powershell
npm run typecheck
node --test tests/documentWorkContract.test.mjs tests/documentWorkIpc.test.mjs tests/documentWorkStore.test.mjs tests/documentWorkService.test.mjs tests/documentWorkRuntimeAdapter.test.mjs tests/documentArtifactStore.test.mjs tests/documentRevisionPolicy.test.mjs tests/documentInspection.test.mjs tests/documentMaterialCache.test.mjs tests/documentWorkRecovery.test.mjs
npm run check:format
git diff --check
```

上述测试文件待开发时创建；本轮未运行这些不存在的测试。触达对齐模块时另跑现有对齐测试；扩展资源变化时检查分发清单。合并前按仓库规则核对跨域回归，基线已有失败不混算为本功能回归。

真实验收会调用模型和文档工具，实施前说明材料、轮次和成本。默认单元测试不调用模型。真实成果、原件、凭据和会话不加入源码仓库。

本轮只编写方案，不发布安装包、不迁移工作台数据。实施完成后更新本文件状态和验收记录，清除已被实际实现取代的未决说明。

## 11. 调研依据

- [Claude Code 权限模式](https://code.claude.com/docs/en/permission-modes)：规划阶段可运行调查命令，实际限制取决于配置。
- [Codex 规划](https://developers.openai.com/codex/learn/best-practices)与[权限边界](https://developers.openai.com/codex/agent-approvals-security)：工作流程、审批和沙箱分别负责不同约束。
- [Gemini CLI Plan 模式](https://geminicli.com/docs/cli/plan-mode)：允许在专用计划目录写入，限制可按用途细分。
- [Google Docs 写入版本控制](https://developers.google.com/workspace/docs/api/how-tos/best-practices)：读取版本与提交版本绑定，避免覆盖后续修改。
- [Word 文档比较](https://support.microsoft.com/en-US/Word/compare-document-differences-using-the-legal-blackline-option)：文字、格式和批注分别比较，原稿可保留。

这些资料用于设计参考，不代表 TPA 已获得对应产品的隔离或文档合并能力。

## 12. 实施记录（实现 B，2026-10-12）

首版按本方案实现。源码位置与本方案的模块划分一致：

| 职责 | 文件 |
| --- | --- |
| 共享契约、解析与预算 | `src/shared/types/documentWork.ts`、`src/shared/documentWork.ts` |
| 存储（原子写入、CAS、幂等台账） | `src/main/document-work/DocumentWorkStore.ts` |
| 路径边界与真实路径逃逸校验 | `src/main/document-work/DocumentPathGuard.ts` |
| 归档字节层（排他版本目录、快照、复制指纹） | `src/main/document-work/DocumentArtifactStore.ts` |
| 基稿选择与范围策略（纯函数） | `src/main/document-work/DocumentRevisionPolicy.ts` |
| OOXML/文本有界解析 | `src/main/document-work/DocumentOoxml.ts` |
| 程序检查（fingerprint/text/format 分项） | `src/main/document-work/DocumentInspectionService.ts` |
| 材料登记与转换缓存 | `src/main/document-work/DocumentMaterialCache.ts` |
| 运行时适配（事件、绑定、稳定点、补登记） | `src/main/document-work/DocumentWorkRuntimeAdapter.ts` |
| 归档编排 | `src/main/document-work/DocumentArchiveService.ts` |
| 工作编排（准备、分发、结算、取消） | `src/main/document-work/DocumentWorkService.ts` |
| 主进程装配 | `src/main/document-work/documentWorkAssembly.ts`、`src/main/ipc/documentWorkIpc.ts` |
| Pi 扩展 | `resources/extensions/pi-deck-document-work.ts`、`pi-deck-document-materials.ts`、`pi-deck-document-work-protocol.ts`、`pi-deck-document-work-binding.ts` |
| 渲染层 | `src/renderer/src/atoms/document-work-atoms.ts`、`hooks/useSessionDocumentWork.ts`、`components/session/DocumentWorkCard.tsx` |

已落实的关键不变量：

- 授权只认权威来源：对齐确认单从原生快照读、改稿指令从会话里那一轮真实用户消息读；渲染层布尔值、模型自报和关键词都不构成授权。
- 先持久化再分发；`accepted` 只表示 RPC 收到，不等价于授权或执行完成；每次异步步骤后复查 `SessionRuntimeTarget`，窗口内换绑记 `interrupted`。
- 绑定命令被拒记 `failed`，被接受但没等到确认记 `unknown` 且不重放；`agent_end` 不结算，必须等 `agent_settled` 且运行时无排队。
- 归档用排他版本目录、复制前后指纹校验、原始字节快照；失败保留 staging 与输入并如实回报。
- 检查分 fingerprint/text/format 三类结论；未授权正文变化记 `failed`，未覆盖结构、超时、超预算记 `unverified`，都不虚报通过。
- 材料转换固定 argv（`anydoc <in> -o <out>`，`shell: false`），缓存键含原件指纹与转换器版本，转换中原件变化即拒绝结果。
- 需求模式取消额外 `bash` 禁令，沿用用户既有 Pi 权限；对齐与文稿之间的绑定闸经共享注册表协作，不靠扩展加载顺序。

验证命令与结果：

```powershell
npm run typecheck        # 通过
npm run check:format     # 通过
node --test tests/documentWorkContract.test.mjs tests/documentWorkIpc.test.mjs tests/documentWorkStore.test.mjs tests/documentWorkService.test.mjs tests/documentWorkRuntimeAdapter.test.mjs tests/documentArtifactStore.test.mjs tests/documentRevisionPolicy.test.mjs tests/documentInspection.test.mjs tests/documentMaterialCache.test.mjs tests/documentWorkRecovery.test.mjs
node --test tests/piDeckAlignmentModeExtension.test.mjs tests/alignmentState.test.mjs tests/alignmentComposer.test.mjs tests/alignmentControlsHook.test.mjs tests/alignmentHistory.test.mjs tests/alignmentProjection.test.mjs tests/alignmentPromptTarget.test.mjs tests/alignmentPresentation.test.mjs tests/alignmentAcknowledgement.test.mjs tests/alignmentQueueHook.test.mjs tests/alignmentDispatchHook.test.mjs tests/sessionSendPromotionFailures.test.mjs
node --test tests/builtInExtensions.test.mjs tests/builtInExtensionDescriptions.test.mjs tests/extensionPackagingDeps.test.mjs tests/extensionManager.test.mjs tests/enabledExtensionResolver.test.mjs tests/extensionBuiltInDisable.test.mjs tests/processGuards.test.mjs
node scripts/generate-extensions-manifest.mjs --check
```

尚未验收的部分（不属于本轮结论）：真实模型端到端制作与改稿、完整 Electron 应用内的交互、安装包内扩展分发、Word 局部修改的真实保真度、结构比较的性能目标（方案 §7 的 p95 目标仍是设计值，没有实测）。

已知取舍：

- 每件工作的成果目录固定为 `<成果根>/<workId>/`，版本序号从 1 递增；跨版本内容去重（同指纹复用）未实现。
- 结构比较在检查服务内做异步让出与硬超时，没有独立 worker 线程；方案 §7 的"worker 执行"仍是后续项。
- 检查器首版覆盖 docx/xlsx/pptx 容器与 Markdown/纯文本；PDF 等格式如实记 `unverified`。
- `create` 的 `sourceTurnId` 记录的是本次提交的程序生成 id，仅作来源登记；授权一律在准备与分发阶段重新推导。

## 13. 审查修正（实现 B，第二轮）

主协调者独立审阅后指出六类缺口，本轮逐条修正并补了行为验证：

1. **会话身份**：绑定载荷同时携带稳定 catalog 会话 id 与**原生 Pi 会话 id**，扩展只用后者校验（新草稿两者不同，旧实现会拒绝所有绑定）；主进程侧 `readAgentRuntimeIdentity` 取原生身份，恢复按原生 id 匹配，换代/旧 runtime 迟到消息被标 stale。联合测试用真实扩展 handler + 真实 service/adapter，覆盖恢复、restart 与迟到拒绝。
2. **授权与当前范围**：首次制作只认**当前**对齐确认单（版本不符→失效、用户指令/未决问题→拒绝）；改稿授权要求该轮是**最后一条真实用户消息**且正文指纹与读回正文一致，角色必须是 user，否定句/提问/assistant 文本/旧轮/编辑后正文一律不授权；范围由**本轮指令**推导（"只改第二节"落到冻结基稿里真实存在的章节），不再沿用上一轮的全篇 scope。
3. **普通聊天改稿入口**：扩展在普通聊天里只报 `tpa-document-work-intent` **候选**；主进程重新验证、等该回合权威稳定且同 runtime 后准备、bind 并只派发一次 `/tpa-work revise`，扩展用主进程冻结的指令正文触发回合。联合测试证明真的产出并归档了新版本。
4. **Windows anydoc**：解析器把 npm `.cmd` shim 还原成 `node + 真实 JS 入口`（完全不经 shell），不再接受无扩展名的 bash shim；固定 argv、`shell:false`、同步 spawn 失败/非零退出/超时都结算；真实进程测试覆盖带空格路径与真机 `anydoc --version`。材料根扩到成果目录 + 会话项目目录。
5. **检查器 worker**：解析与比较移到可终止的 `worker_threads` worker（`resources/document-work/*.cjs`，随包分发），2 秒硬截止用 `terminate()` 真打断，并发 2；页眉页脚正文、编号、表格、修订、文本框、重复标题、异常 ZIP/XML、超预算一律 `unverified`；同长度格式变化由逐块格式指纹（真实哈希）与整篇格式哈希证据支撑。程序格式检查不等于渲染验收。
6. **档案损坏与幂等**：主档损坏时**不自动修复、不重建**，`.bak` 只作只读展示，损坏文件原样保留且写入与新执行被拒；`prepare/start/cancel` 全程持按 workId 的互斥锁，重复确认只发一次 approve 与实际 prompt，未知分发不重放。

仍属未验收：真实模型端到端（初稿 → 改稿 → 重开）、完整 Electron 交互与安装包分发、Word 局部修改保真度、方案 §7 的性能目标（p95）未实测。

## 14. 第二轮审查修正（实现 B · 2026-10-12）

1. **普通 Plan 不被文稿流程阻断**：新增纯策略 `src/shared/documentWorkTarget.ts`（renderer 与主进程共用），
   `classifyDocumentTarget`/`shouldRouteRoundToDocumentWork`/`shouldBlockDocumentApproval` 只从权威要求单的
   goal/deliverable 判断"本轮是否正式文稿"。普通开发（重构代码、修 bug、解释材料）在需求模式下也
   **0 个文稿 create/prepare/start、不要求成果目录**，原生 approve 一次；`resolveCreateAuthorization` 在主进程侧
   用同一判据再挡一次，renderer 标志无法自证文稿授权。
2. **批准只发一次**：`beforeApprove` 改为三态 `handled | proceed | blocked`。文稿轮次的 `/align approve`
   只由主进程的 dispatcher 发出，前端在 `handled` 分支只同步"退出对齐模式 + 清 pending/error"，
   不再发原生批准；普通开发走 `proceed`（原生一次）；失败走 `blocked`（两边都不发）。
3. **扩展批准闸只约束进行中的同轮次**：`roundActive()` 增加回合结束（agent_end）判定；
   归档/取消/失败后保留文稿关联只用于读与改稿意向，不再注入旧制作指令、不再阻断同会话后续的
   普通 Plan 确认；绑定载荷损坏也不再永久阻断批准。
4. **同一运行时排他租约**：新增 `src/main/document-work/DocumentWorkRuntimeLease.ts`，
   以运行时身份（sessionId + agentId + generation + 原生会话 id）为键，覆盖"占用 → 绑定 → 运行 → 权威结算"。
   两件不同工作在同一运行时并发确认时，后到的一件在**发出绑定之前**就被拒（`RUNTIME_BUSY`）；
   不同运行时仍可并行；取消与终态释放租约且只释放自己那一份；未知分发的重放保护仍来自 requestId 台账与终态。
   锁顺序固定：先 workId 互斥，再运行时租约（同步 Map，无 await，不成环）。

## 15. 第三轮审查修正（实现 B · 批准回执与未知运行时占用）

1. **建记录失败必须拦下**：`beforeApprove` 已确定本轮是正式文稿后，`ensureWork` 失败（存档不可写/校验失败）
   改为返回 `blocked` 并给出明确错误，绝不退回原生 approve 绕过归档与检查；普通 coding 仍 `proceed`。
2. **批准 fence 冻结**：`useSessionAlignmentControls.approve` 在 `await` 文稿桥**之前**冻结运行时三元组与
   确认单版本，`await` 之后只与冻结快照比较。换代时旧点击不再改动新运行时的模式/pending/error，
   也不会把旧确认单发给新运行时。
3. **`handled` 不等于已批准**：`start` 只表示主进程收取了本轮操作（后台可能仍在等绑定确认）。
   前端在 `handled` 分支等待**同一 frozen briefId+revision+runtime** 的 `approved/complete` 回执
   （复用 `waitForAlignmentAcknowledgement`）才切换 UI；超时/失败/换代保留实际状态与输入。
   唯一 approve owner 仍是主进程，桥不额外发批准。
4. **未知分发保守占用运行时**：`unknown` 不再自动释放同运行时。`DocumentWorkStore.blockingUnknownOperation`
   是**持久化**判定（重启后仍生效）：同一会话里存在结果未知且 runtime 三代组相同的操作时，
   新的文稿 attempt（含另一件工作的新 requestId）一律 `DISPATCH_UNKNOWN` 拒绝；解除方式只有
   用户显式取消（`unknown → interrupted`）或会话换绑到新运行时。租约与 workId 互斥顺序不变，清理成对。
