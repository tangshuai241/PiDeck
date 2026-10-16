# TPA 调度、执行与审查流程

## 入口与事实来源

项目根 `AGENTS.md` 决定会话的默认角色和恢复动作。main 无有效派工的会话默认读 [调度台职责](agent-roles/dispatcher.md)；执行和审查分别读 [执行者职责](agent-roles/executor.md)、[审查者职责](agent-roles/reviewer.md)。任务字段见 [模板](templates/orca-task.md)。

三个角色同时遵循 [目标对齐、研究与判断原则](agent-roles/working-principles.md)。角色职责不只是流程分工：调度台判断目的与价值，执行者判断方法，审查者判断目标、质量与证据。高度、深度、广度和速度都要服务用户收益，不自动增加权限。

这些文件定义职责，不保存活跃任务台账。Orca Run/Tasks/gates 保存当前运行事实；Git 保存版本；报告保存验证证据。已确认的目的、场景、取舍和假设随任务记录保存；聊天摘要、Engram 和终端标题只能帮助定位，不能授予权限或证明任务结束。

本流程是 Agent 应遵守的规则，不是常驻调度服务，也不是 Git 强制保护。用户只需与调度台沟通；会话中断后，恢复者必须重新查证状态。

## 恢复检查

每次启动、compact 后继续或接手时，先重新读根规则与角色文件，再只读核查。先按安装的 orca-cli/orchestration 技能解析本机可执行文件，读取对应指南。下文 `orca` 是命令示例，实际使用技能选定的同一个可执行文件；不猜测新版参数。

```text
git rev-parse --show-toplevel
git branch --show-current
git status --short
orca orchestration run-current --json
orca orchestration run-list --json
orca orchestration task-list --run <run_id> --json
orca orchestration gate-list --run <run_id> --json
orca orchestration worker-list --run <run_id> --json
orca worktree list --json
```

占位符必须替换为当次查询确认的值；列表有分页时继续读取。不能把发现一个 Run 等同于有权接管它。

- 对照用户任务目标、仓库/工作区、Task结果、当前worker状态与pending gate定位待办。必要时读关联报告；本地历史实施报告默认在集合的 `output/TPA/` 下，只作线索，不当作当前状态。
- 多个 Run 可能匹配时，不按「最新一个」猜。确认范围和原调度者是否仍在活动；无法确认就报告阻塞。
- 仅在有权接管且旧调度者不再拥有运行时，才执行当前CLI支持的 `orca orchestration run-use --id <run_id> --json`。不要用只读恢复测试抢占真实 Run。
- 原终端句柄失效时重新发现；不同时向旧句柄和新句柄发同一任务。失败、退出、无输出与资源可释放是不同状态。
- 恢复时找回用户目的和已确认的关键取舍，不只找任务编号。恢复回执至少说明当前阶段、候选、审查、授权、阻塞和下一步。检查未完成前不写代码、不派工、不清理。
- 相同状态只报告一次；有新证据、阻塞、授权请求或交付时再更新。用户要求先讨论时不写文件，确认后再写，不循环发送同一计划。

## 正常流程

### 1. 明确任务与权限

调度台先区分讨论、调查和执行请求。对开放需求先查现状并判断必要性，给出目的、场景、边界、成功/失败例子和未决项的对齐摘要；区分用户原话、推断与未知。只向用户确认会改变方向、成本、风险或验收的分歧，技术事实自行调查。明确小任务不强制套长问卷。

有证据表明不做、配置现有能力或更小改动更合适时，调度台应给出理由和替代建议；用户知情确定方向后不反复争辩，除非出现新证据。

关键能力未知时先派有限调查或可逆试验，不直接承诺最终指标。根据不确定性和风险明确研究问题、可用专业工具、来源要求、投入上限和停止条件；小任务复用现有方法，不为深度而研究。费用、安装、数据上传和范围扩大分别按权限处理。

执行请求用模板记录已经对齐的目标、范围、验收、不做什么、风险、环境和授权来源。对齐确认不等于操作授权；用户授权可以被任务书转达，但不能由调度者自行创造。

区分业务任务和阶段 Task：一个业务任务可以包含调查、执行、审查、返工等多个 Orca Task；只在有实际依赖时增加阶段，不机械拆成完整流水线。阶段 completed 不代表业务任务关闭。

需要监督时创建 Run，阶段 Task 用真实依赖排序。只读查询参数以当前 `--help` 为准：

```text
orca orchestration run-create --objective "<业务目标>" --json
orca orchestration task-create --task-title "<执行阶段>" --spec "<自包含任务书>" --run <run_id> --json
```

### 2. 准备工作区再派工

业务写入必须在独立工作区。复用仅限同一未关闭业务任务，且已确认原写者停止、无其他占用、基线和现存修改归属明确。无法隔离就停止，不退回共享树。

派工前确认基线包含所需规则版本。main 的未提交角色文件不会自动进入新 Git 工作区；应先说明差异并处理提交或明确的规则传达授权，不能假定新执行者已经继承，也不能暗中复制覆盖文件。

源码任务先创建工作区，不同时启动业务 Agent：

```text
orca worktree create --repo id:<repo_id> --name <task_name> --base-branch <base_ref> --setup run --json
```

创建回执不等于 setup 成功。核对实际准备终端的结束状态、退出码和日志；超时或失败时不派业务 Agent。默认终端配置也可能运行命令，必须确认没有意外写者。环境准备不能并发改共享 `node_modules`。

准备成功后才在已有工作区启动：

```text
orca orchestration worker-start --task <task_id> --run <run_id> --worktree path:<task_path> --agent <agent_id> --json
```

已有工作区不会自动重跑 setup；文档任务可记录理由后显式 `--setup skip` 创建工作区。不假定本机的 `start-immediately` 已改成 `wait-for-setup`。

启动返回非零时先读 failedStage/residualResources，报告并停止派工，不悄悄换启动方式。原生恢复按当版指南和用户决定执行。

### 3. 冻结候选与独立审查

有提交授权：执行者提交并报告完整 base/candidate SHA。用 `git rev-parse <ref>^{commit}` 获取完整值，不只记缩写。审查绑定这些值和验收标准；工作区内容必须与候选一致。

无提交授权：保留基线 SHA、文件/删除清单、逐文件 SHA-256和差异。审查只能批准该未提交快照；后续形成提交时重新核验，不把快照审查直接用于业务合并。

审查者同时检查已确认的用户目的、方案的专业适配、真实证据与反例、工程和维护成本。研究缺失只有造成判断无依据或实质风险时才成为问题；研究很多或多个Agent同意也不是正确性证明。

审查发现重大目标问题时交回调度台重新对齐，不能临时扩验收。问题分为阻断项、非阻断改进、待用户决定；不以问题数量证明价值。

审查Task可以依赖执行Task completed，但必须另行报告候选「通过/退回/阻塞」。`worker_done` 的 succeeded 表示阶段已完成；审查Task completed 不等于候选通过。

用户明确要求在 main 修改调度配置时，可以在 main 修改根规则和配套文档，并按未提交快照做独立评审、只读恢复演练。此例外不用于业务开发，也不授权提交/推送。

### 4. 两道门禁后才集成

集成Task可以依赖审查阶段，但建立后立即创建两道pending gate，在门禁建立及核实前绝不派发集成动作：

```text
orca orchestration task-create --task-title "<集成阶段>" --spec "<集成要求>" --deps '["<review_task_id>"]' --run <run_id> --json
orca orchestration gate-create --task <integration_task_id> --question "<本轮完整base/candidate及验收是否经独立审查通过>" --json
orca orchestration gate-create --task <integration_task_id> --question "<用户是否授权本轮候选的main合并及推送，分别记录范围>" --json
```

- 审查通过gate：只有准确绑定当前候选的通过报告才能解除。
- 用户授权gate：只有明确用户授权才能解除；仅批准合并时不得推送。
- `gate-resolve --id <gate_id> --resolution "<来源、完整SHA与允许动作>"` 会解除门禁。写入「拒绝」「稍后」并不代表仍阻塞；不批准就保持pending，在Task结果或消息中记录理由。
- 候选、main基线或验收要求变化时，旧批准失效。先停止集成，再创建新的pending gate；没有已验证的gate重开API，不假装把旧resolved gate改回pending。
- 若集成worker已运行，先按原生协议停止并得到退出证据；不能认为新建gate会撤销已经运行的动作。
- 执行前再次核查两道当前gate、当前SHA、干净状态和授权；操作后记录合并SHA、验证与推送结果。只用自有origin，不自动同步上游或镜像。

### 5. 退回与失败

完成的执行Task不假定可以直接重开。正常返工采用新Task：

1. 审查Task完成但结论退回；审查通过gate保持pending，集成不派发。
2. 新建修复Task，`--parent <original_task_id>`关联原执行阶段，`--deps '["<review_task_id>"]'`表达先收到审查结论。
3. 按复用条件核实原工作区；不满足时新建隔离工作区，不触碰原写者资源。
4. 修复后得到新冻结候选，再建依赖修复Task的新审查Task。旧审查不继承。
5. 集成Task若仍未派发，可保留原依赖图作为历史顺序，但必须用本轮新增pending gates绑定最新候选和新审查报告。Task结果注明替代关系；不能把旧依赖completed当新审查批准，也不编造 `task-deps` 修改命令。
6. 同一业务任务连续两次审查退回后，向用户说明争议和建议，不无限自动循环。

真正失败的Task才按当前指南使用 `worker-start --task <failed_task_id> --retry-of <failed_dispatch_id>`；重新明确placement与agent，先核实旧实例退出。取消Task时按当前CLI停止/结算worker，再 `task-update --status failed --result "cancelled: <理由>"`；文字标注不替代生命周期操作。

## 消息、保留与收尾

- 接收用 `orchestration check --run <run_id> --wait`；处理整批消息后再用 `--ack <delivery_id>`确认。消息入队不证明对方已阅读。
- `send`当前使用 `--type`、`--subject`、`--task-id` 等参数；worker生命周期消息严格照有效preamble，不从旧文件复制 capability 或句柄。
- 有效 `worker_done` 自动结算对应Task/Dispatch，不再重复手工completed；结算后记录立即复用、用户要求保留或原生释放决定。
- `worker-release --dispatch <dispatch_id>` 只处理已结算、归属明确的执行资源，不等于工作区归档。读取实际 state/reason/processAction；retained/user_takeover不等于已释放，release_unknown不能猜测成功或手工kill。
- 固定审查入口按用户要求保留；一次性只读验证worker结束后按原生流程释放。
- 工作区归档另用Orca管理，先核对提交、未提交成果、占用和授权。没有授权或归属不明时保留，不为整洁而删除。

最终回执先说明原问题改善了什么、证据是否足够、引入什么成本与未解决风险，再分别列执行、审查、集成、推送、资源状态。预期收益与实际观察分开，不拿任务完成数代替用户收益。

重要任务可回看误解是否提前发现、专业方法是否改变方案、审查是否减少返工、维护负担是否值得；小任务不强制增加复盘文档。经验以证据更新既有规则，不另造任务账本。

未提交配置可以已经被本地新会话读取，但必须明确它尚未进入Git提交、没有远端备份；不要称为已发布。
