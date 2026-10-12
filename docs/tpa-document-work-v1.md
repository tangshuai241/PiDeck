# TPA 文稿执行、成果归档与改稿方案

状态：方案已按实现 A 落地源码与自动化测试；真实模型文稿链路与安装包验收未做。日期：2026-10-12。

本方案定义 TPA 独立完成正式文稿的首版范围、模块接口和验证要求。

实现落地情况、取舍与验证范围见文末「实现记录（2026-10-12）」；该节区分了自动化验证与尚未完成的真实验收。

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

## 实现记录（2026-10-12）

本节记录首版实现的实际形态、取舍与验证范围，不改变上面各节的契约；两者不一致时以本节为准并同步修订上文。

### 落地的模块

| 模块 | 文件 |
| --- | --- |
| 共享类型与常量 | `src/shared/types/documentWork.ts` |
| 有界协议解析与纯策略 | `src/shared/documentWork.ts` |
| 磁盘记录与渲染快照解析 | `src/shared/documentWorkRecords.ts` |
| 元数据存储（CAS / 去重 / 恢复） | `src/main/document-work/DocumentWorkStore.ts` |
| 文件原语（指纹 / 原子写 / 真实路径边界） | `src/main/document-work/documentWorkPaths.ts` |
| 归档与快照（排他版本目录） | `src/main/document-work/DocumentArtifactStore.ts` |
| 只读 ZIP 解析 | `src/main/document-work/zipEntries.ts` |
| 注册式格式检查器 | `src/main/document-work/documentInspectors.ts` |
| 检查服务（预算 / 超时 / 聚合） | `src/main/document-work/DocumentInspectionService.ts` |
| 基稿与范围纯策略 | `src/main/document-work/DocumentRevisionPolicy.ts` |
| 编排（建立 / 准备 / 分发 / 结算 / 取消） | `src/main/document-work/DocumentWorkService.ts` |
| 运行时适配（三元组 / 稳定完成 / 派发） | `src/main/document-work/DocumentWorkRuntimeAdapter.ts` |
| 域装配与 pi 事件适配 | `src/main/document-work/index.ts` |
| IPC 边界 | `src/main/ipc/documentWorkIpc.ts` |
| Pi 扩展（绑定 / 候选汇报 / 改稿意图） | `resources/extensions/pi-deck-document-work.ts`、`pi-deck-document-work-types.ts` |
| Pi 材料工具（anydoc 固定 argv + 缓存） | `resources/extensions/pi-deck-document-materials.ts` |
| 渲染层 | `src/renderer/src/atoms/document-work-atoms.ts`、`hooks/useSessionDocumentWork.ts`、`components/session/DocumentWorkCard.tsx`、`utils/documentWorkPresentation.ts` |

### 与方案的差异与取舍

1. 文稿状态不写进 `AgentRuntimeState`，而是走独立通道 `document-work:changed`。原因是主进程自己就是工作/操作/版本记录的事实源，把它塞进每次运行时补丁会污染既有对齐投影，也违反「一个新能力一个注册入口」的约束。
2. 改稿授权用「最新用户轮正文 sha256」而不是消息条目 ID。扩展与主进程对同一段文本独立求指纹，因此授权绑定到真实用户输入，又不依赖两边的 ID 生成方案。
3. 主进程在确认时按固定顺序分发两条命令：先 `/tpa-work bind`，等扩展确认绑定后，才发 `/align approve`。渲染层无法重排这个顺序，也不自行判定批准。
4. 「本轮是否开始过」的判据是「观察到运行中状态」或「已收到候选汇报」。`/align approve` 被接受时运行时可能仍是 idle，只按稳定完成结算会立刻收出空版本。
5. 对齐路径的修改范围只填 `summary` 与 `preserve`，`sections` 留空；章节引用校验用在模型声明的改稿意图上（模型看得到基稿标题）。这是为了避免把自然语言范围误判成范围冲突。
6. 检查项固定为：文件可读、正文非空、无重复标题、无未解析修订、无文本框、格式已注册；改稿另加「正文确实变化」。任何 `unverified` 都会让整版不是 `passed`，也就不会自动成为下一轮基稿。
7. 关闭或退出时先取消在途结算再 drain，未完成的运行留给启动结算记 `interrupted`；未知分发记 `unknown`，两者都不自动重放。
8. 输出根与材料路径都只能来自系统选择器；主进程另外接受会话项目目录内的材料。

### 验证范围

自动化验证（`node --test`，10 个新增测试文件、70 项全绿）覆盖：协议边界与预算、扩展镜像与主进程解析一致性、CAS/去重/重启恢复、端到端新建与改稿归档、授权与准备失效、运行时换代与忙碌、绑定未确认、材料变化、取消、版本目录防覆盖、检查器（docx/markdown/未知格式/超预算/超时/内容相同包不同/等长文本变化）、基稿选择与手工接续、anydoc 缓存与失败、IPC 入参边界、卡片呈现策略。

尚未验证的部分：真实模型出稿的端到端链路、真实 Electron 应用内的完整交互、安装包，以及真实 anydoc 对真实 Word/PDF 的转换结果。浏览器（msedge 独立 profile）验证未执行。自动化测试与合成文稿不能替代这些验收。
