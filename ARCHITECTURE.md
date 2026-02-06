# Dynamic Context Pruning (DCP) 架构文档

## 目录

1. [项目概述](#1-项目概述)
2. [核心问题与设计目标](#2-核心问题与设计目标)
3. [整体架构](#3-整体架构)
4. [核心模块详解](#4-核心模块详解)
5. [策略系统](#5-策略系统)
6. [裁剪时机与触发机制](#6-裁剪时机与触发机制)
7. [正确性保证机制](#7-正确性保证机制)
8. [成本收益分析](#8-成本收益分析)
9. [关键设计决策与取舍](#9-关键设计决策与取舍)
10. [扩展与维护指南](#10-扩展与维护指南)

---

## 1. 项目概述

Dynamic Context Pruning (DCP) 是 OpenCode AI 编辑器的插件，通过智能管理会话上下文来优化 token 使用。它采用分层策略自动删除过时的工具输出，同时提供 AI 引导的手动裁剪能力。

### 核心价值

- **节省 token 成本**：长对话可节省 50-80% 的 token 消耗
- **保持模型能力**：避免上下文超过 100k tokens 后的能力下降
- **无感知自动化**：低风险裁剪自动执行，高风险决策由 AI 参与

---

## 2. 核心问题与设计目标

### 2.1 核心矛盾

上下文管理面临一个根本矛盾：

```
裁剪本身的成本              vs    不裁剪的代价
├─ 额外 API 请求                  ├─ token 费用持续增加
├─ 系统提示词占用 token           ├─ 模型能力下降（>100k）
├─ KV 缓存失效                    └─ 响应质量降低
└─ AI 判断的计算开销
```

### 2.2 设计目标

1. **盈亏平衡点最小化**：确保裁剪收益尽快超过成本
2. **渐进式响应**：根据紧急程度采取不同强度的措施
3. **安全性优先**：宁可保守也不误删重要内容
4. **透明可观测**：提供统计和日志以便调试

### 2.3 核心设计原则

| 原则         | 描述                                   |
| ------------ | -------------------------------------- |
| 自动策略优先 | 依赖插件自动裁剪 > 依赖模型主动裁剪    |
| 分层处理     | 低风险自动处理，高风险 AI 参与         |
| 最小伤害     | 优先删除低价值内容（错误、重复、过时） |
| 用户优先     | 不强制裁剪，决策权在用户/AI            |
| 幂等安全     | 重复操作不产生副作用                   |

**为什么自动策略优先**：

- 模型专注于用户任务时容易忽略"裁剪"这个元任务
- 不同模型/版本对 nudge 提示的响应程度不同
- 自动策略稳定可靠，不破坏缓存，不依赖模型"自觉"

---

## 3. 整体架构

### 3.1 系统流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenCode API                             │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
    ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
    │ system.     │   │ messages.   │   │ command.    │
    │ transform   │   │ transform   │   │ execute     │
    │   (注入     │   │   (核心     │   │   (/dcp     │
    │ 系统提示)   │   │   处理)     │   │    命令)    │
    └─────────────┘   └─────────────┘   └─────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────────┐     ┌─────────────────────┐
    │   State Manager     │     │   Strategy Engine   │
    │  ├─ Session State   │     │  ├─ Deduplication   │
    │  ├─ Tool Cache      │     │  ├─ SupersedeWrites │
    │  └─ Persistence     │     │  ├─ PurgeErrors     │
    └─────────────────────┘     │  ├─ PurgeStaleOutputs│
                                │  └─ AggressivePrune │
                                └─────────────────────┘
                                          │
                              ┌───────────┴───────────┐
                              ▼                       ▼
                    ┌─────────────────┐     ┌─────────────────┐
                    │  Message Prune  │     │  AI Tools       │
                    │  (实际修改消息) │     │  ├─ discard     │
                    └─────────────────┘     │  └─ extract     │
                                           └─────────────────┘
```

### 3.2 处理流水线

每次消息转换时，按以下顺序执行：

```
1. checkSession()           ─── 检测会话变化、压缩事件
2. syncToolCache()          ─── 同步所有工具参数到缓存
3. 缓存失效检查              ─── 基于消息哈希判断是否清空 token 缓存
4. deduplicate()            ─── 策略：去重
5. supersedeWrites()        ─── 策略：超写覆盖
6. purgeErrors()            ─── 策略：错误清除
7. purgeStaleOutputs()      ─── 策略：过时输出清除（基于工具数量和年龄）
8. aggressivePrune()        ─── 策略：激进裁剪（基于 token 预算）
9. prune()                  ─── 实际执行裁剪（替换为占位符）
10. cleanupPruneState()     ─── 定期清理无效的 prune 状态（每 10 轮）
11. cleanHistoricalPrunableTools() ─── 清理历史消息中的旧 prunable-tools 注入
12. insertPruneToolContext() ─── 按需注入可裁剪工具列表 + 提示（on_demand 模式）
13. [可选] injectAdvisorSuggestion() ─── 仅在列表已注入时，注入小模型裁剪建议
14. [可选] triggerAdvisorAnalysis() ─── 异步触发小模型分析（如果满足条件）
15. saveContext()            ─── 持久化日志
```

### 3.3 模块依赖关系

```
lib/
├── hooks.ts                 # 入口：注册所有钩子
├── config.ts                # 配置加载与合并
├── state/
│   ├── types.ts             # 类型定义
│   ├── state.ts             # 会话状态管理
│   ├── tool-cache.ts        # 工具参数缓存
│   └── persistence.ts       # 状态持久化
├── strategies/
│   ├── index.ts             # 策略导出
│   ├── deduplication.ts     # 去重策略
│   ├── supersede-writes.ts  # 超写覆盖策略
│   ├── purge-errors.ts      # 错误清除策略
│   ├── purge-stale-outputs.ts # 过时输出清除策略
│   ├── aggressive-prune.ts  # 激进裁剪策略
│   ├── tools.ts             # discard/extract 工具
│   └── utils.ts             # 通用工具函数
├── advisor/                 # [可选] 小模型裁剪建议
│   ├── index.ts             # 模块导出
│   ├── types.ts             # 类型定义
│   ├── trigger.ts           # 触发条件检查
│   ├── analyze.ts           # 小模型调用（临时会话）
│   ├── prompt.ts            # 提示词构建
│   ├── parse.ts             # 响应解析
│   ├── inject.ts            # 建议注入
│   ├── feedback.ts          # 反馈收集
│   └── context.ts           # 分析上下文构建
├── messages/
│   ├── prune.ts             # 消息内容修改
│   ├── inject.ts            # 上下文注入
│   └── utils.ts             # 消息处理工具
├── prompts/
│   ├── index.ts             # 提示词加载
│   ├── nudge.ts             # 提示消息
│   ├── system/              # 系统提示词
│   └── *-tool-spec.ts       # 工具描述
└── commands/                # /dcp 子命令
```

---

## 4. 核心模块详解

### 4.1 状态管理 (State)

#### 会话状态结构

```
SessionState {
  sessionId              # 当前会话 ID
  isSubAgent             # 是否为子代理（子代理禁用 DCP）
  variant                # 模型变体标识

  prune {
    toolIds[]            # 标记为裁剪的工具 ID 列表
    toolIdSet            # 快速查询集合（O(1) 查找）
  }

  stats {
    pruneTokenCounter    # 本轮节省的 tokens
    totalPruneTokens     # 累计节省的 tokens
    currentPrunableTokens # 当前可裁剪的 tokens（仅计算非保护工具）
  }

  toolParameters         # 工具元数据缓存 Map<callId, Entry>
  nudgeCounter           # 提示频率计数器
  currentTurn            # 当前轮数（用于 turnProtection）
  lastCompaction         # 最后压缩时间戳
  aggressivePruneExhausted  # 激进裁剪后仍超标的抑制标志

  # 性能缓存
  toolIdListCache        # 所有工具 ID 列表
  toolIdListCacheHash    # 列表哈希（用于失效检测）
  toolIdToIndexCache     # ID 到索引的映射
  toolIdToPartCache      # ID 到消息/部分位置的映射（用于 O(1) 查找）
  toolTokensCache        # 工具 token 数缓存
  toolTokensCacheHash    # token 缓存哈希（基于消息变化失效）

  # 快照（用于 ID 一致性验证）
  prunableToolIdList     # 快照：可裁剪工具的 {callId, tool} 列表
  prunableListVersion    # 快照版本号（内部跟踪用）
}
```

**注意**：`currentPrunableTokens` 只统计可裁剪的、非保护的工具输出 token，不包含系统提示、用户消息、AI 回复等。因此实际上下文大小可能远大于此值。

#### 状态生命周期

```
新会话                          会话中断/恢复
   │                                  │
   ▼                                  ▼
createSessionState()          loadSessionState()
   │                                  │
   ├─ 初始化空状态                    ├─ 从磁盘加载
   └─ 检测子代理                      └─ 恢复 prune.toolIds、stats 和 exhausted

压缩事件检测                     保存状态
   │                                  │
   ▼                                  ▼
lastCompaction 变化时            saveSessionState()
   │                                  │
   ├─ 清空 toolParameters             └─ 保存到 ~/.local/share/opencode/
   ├─ 清空 prune                          storage/plugin/dcp/{sessionId}.json
   └─ 重置所有缓存
```

#### 工具参数条目

```
ToolParameterEntry {
  tool        # 工具名称 (read, write, bash, etc.)
  parameters  # 工具参数 (file_path, command, etc.)
  status      # 执行状态 (pending, running, completed, error)
  error       # 错误信息（仅 status=error 时）
  turn        # 创建时的轮数
}
```

### 4.2 配置系统 (Config)

#### 配置层次（优先级从低到高）

```
1. 硬编码默认值 (defaultConfig)
   └─ 确保所有配置项都有合理默认值

2. 全局配置 (~/.config/opencode/dcp.jsonc)
   └─ 用户级别的通用配置

3. ConfigDir 配置 ($OPENCODE_CONFIG_DIR/dcp.jsonc)
   └─ 环境变量指定的配置目录

4. 项目配置 (.opencode/dcp.jsonc)
   └─ 项目级别的特定配置（最高优先级）
```

#### 关键配置项

| 配置                                 | 默认值    | 说明                                                                 |
| ------------------------------------ | --------- | -------------------------------------------------------------------- |
| `tokenBudget.warnThreshold`          | 60000     | warn 警告阈值，触发 Tier1 (error 工具清理)，同时也是所有裁剪的目标线 |
| `tokenBudget.criticalThreshold`      | 100000    | critical 警告阈值，触发 Tier2 (激进裁剪)                             |
| `tools.settings.nudgeFrequency`      | 10        | 每 N 个工具后提示一次（备用机制）                                    |
| `tools.settings.injectPrunableTools` | on_demand | 注入模式：always/on_demand/on_warn                                   |
| `turnProtection.turns`               | 4         | 新工具的保护轮数                                                     |
| `strategies.purgeErrors.turns`       | 4         | 错误工具的保留轮数                                                   |
| `strategies.purgeStaleOutputs.turns` | 5         | 过时输出的年龄阈值                                                   |

**阈值约束**：`warnThreshold ≤ criticalThreshold`，配置加载时会验证此约束。

#### 默认保护工具列表

```
task, todowrite, todoread, discard, extract,
batch, write, edit, plan_enter, plan_exit
```

这些工具的输出默认不会被自动裁剪，因为：

- `task/todowrite/todoread`：任务追踪信息
- `write/edit`：文件修改可能需要回溯
- `discard/extract`：DCP 自身的工具
- `batch`：批量操作的组织信息

### 4.3 提示词系统 (Prompts)

#### 系统提示词

根据启用的工具选择不同的提示词：

| 条件                     | 提示词                |
| ------------------------ | --------------------- |
| discard + extract 都启用 | SYSTEM_PROMPT_BOTH    |
| 仅 discard 启用          | SYSTEM_PROMPT_DISCARD |
| 仅 extract 启用          | SYSTEM_PROMPT_EXTRACT |

#### 提示词核心内容

系统提示词传达以下核心原则：

1. **默认行为是删除**：保留是例外，不是规则
2. **明确的删除条件**：噪音、错误、过时内容立即删除
3. **明确的保留条件**：必须同时满足"正在多步编辑"和"需要精确内容"
4. **N+ 规则**：可裁剪列表达到 `PRUNABLE_TOOL_THRESHOLD`（默认 8）个以上时应该主动裁剪
5. **静默处理**：不在回复中提及裁剪相关信息

#### 提示消息 (Nudge)

三个紧急级别，语气逐渐增强但始终尊重模型自主决策：

| 级别     | 触发条件                                          | 指令强度                      | 是否注入列表 (on_demand 模式) |
| -------- | ------------------------------------------------- | ----------------------------- | ----------------------------- |
| normal   | N+ 工具（N = PRUNABLE_TOOL_THRESHOLD）或 频率触发 | SHOULD — 可选建议             | ✅ 注入                       |
| warn     | >= 60k tokens (warnThreshold)                     | SHOULD — 推荐裁剪             | ✅ 注入                       |
| critical | >= 100k tokens (criticalThreshold)                | MUST — 强烈建议，提示性能影响 | ✅ 注入                       |

**注入方式**：所有裁剪提示均以 user 消息注入（而非 assistant prefill），确保：

- 模型将其视为建议而非自身知识，可自主决定是否采纳
- 兼容所有模型（opus-4-6 不支持 assistant prefill）

**设计理念**：系统不自动强制裁剪（自动策略除外），裁剪决策权在 AI：

- 能力下降 ≠ 不可用，某些长任务确实需要超长上下文
- 超过 100k 时触发 critical + 激进裁剪，但如果裁剪后仍超标则不持续警告
- 后续轮次静默，直到计数器触发时再次提醒，避免干扰超长任务
- OpenCode 会话压缩作为系统级兜底机制

---

## 5. 策略系统

### 5.1 策略分类

```
          自动策略（无需 AI 判断）              AI 引导策略
          ├─ 确定性高                          ├─ 需要语义理解
          ├─ 零额外 token 成本                 ├─ 消耗额外 token
          └─ 静默执行                          └─ 通过工具调用
                    │                                  │
    ┌───────────────┼───────────────┐          ┌───────┴───────┐
    ▼               ▼               ▼          ▼               ▼
去重策略      超写覆盖策略     激进裁剪策略   discard        extract
(100% 安全)   (95% 安全)      (基于预算)     (完全删除)     (提炼后删除)
    │               │               │              ▲
    │               │               │              │
    ▼               ▼               ▼              │
错误清除策略   过时输出清除策略              小模型 Advisor
(90% 安全)    (基于工具数量和年龄)          (语义分析建议)
```

### 5.2 去重策略 (Deduplication)

**原理**：相同工具 + 相同参数 = 完全重复的信息

**实现逻辑**：

1. 为每个工具调用创建签名：`tool::JSON(sorted_parameters)`
2. 按签名分组
3. 每组仅保留最新的一个，其余标记为裁剪

**参数规范化**：

- 忽略 undefined/null 值
- 对象键排序确保稳定性

**风险等级**：极低 - 重复内容必然冗余

### 5.3 超写覆盖策略 (SupersedeWrites)

**默认状态**：启用

**原理**：write/edit 后又 read 同一文件，write 的输入内容已被 read 结果覆盖

**实现逻辑**：

1. 追踪所有 write/edit 调用及其文件路径和时序索引
2. 追踪所有 read 调用及其文件路径和时序索引
3. 对于每个 write，检查是否存在后续的同路径 read
4. 如果存在，标记该 write 为裁剪

**关键细节**：

- 只删除 write 的**输入内容**（写入了什么）
- 不删除 write 的**输出结果**（是否成功）
- 最新文件状态已在 read 结果中捕获

**风险等级**：低 - 逻辑上 read 结果包含最新状态

### 5.4 错误清除策略 (PurgeErrors)

**原理**：失败命令的输入参数价值低，但错误消息有诊断价值

**实现逻辑**：

1. 找出所有 status=error 的工具
2. 计算每个工具的"年龄"（当前轮数 - 创建轮数）
3. 年龄 >= 配置阈值（默认 4 轮）的，标记为裁剪

**裁剪方式**：

- 保留错误消息（AI 仍知道操作失败）
- 删除输入参数（通常较大）

**风险等级**：极低 - 失败输入很少需要回溯

### 5.5 过时输出清除策略 (PurgeStaleOutputs)

**原理**：超过一定轮数的工具输出通常不再被引用，可以安全删除

**触发条件**：

- 可裁剪工具数量 >= `minPrunableCount`（默认 10）
- 工具输出年龄 >= `turns`（默认 5 轮）

**实现逻辑**：

1. 统计可裁剪工具数量
2. 如果数量 >= minPrunableCount，扫描所有工具
3. 按工具类型分组，计算每个工具的年龄
4. 对于年龄 >= turns 的工具，保留最近 `preserveRecent` 个同类工具
5. 其余标记为裁剪

**配置项**：

```
strategies.purgeStaleOutputs: {
  enabled: true,
  turns: 5,           // 超过 5 轮视为过时
  minPrunableCount: 10,  // 可裁剪数量 >= 10 时触发
  preserveRecent: 3,  // 保留最近 3 个同类工具
  protectedTools: []  // 额外保护的工具类型
}
```

**风险等级**：低 - 旧输出很少被回溯，且保留最近同类工具

**与激进裁剪的区别**：

- purgeStaleOutputs：基于工具数量和年龄，保留同类工具的最近几个
- aggressivePrune：基于 token 预算，按时序删除最旧的

### 5.6 激进裁剪策略 (AggressivePrune)

**原理**：基于 token 预算自动裁剪内容，减轻 AI 手动裁剪负担

**两层裁剪逻辑**：

```
第一层（Tier1）：达到 warnThreshold (60k) 时
├─ 只删除 error 工具（最低价值）
├─ 按时间顺序，最旧的先删
└─ 目标：降到 warnThreshold 以下

第二层（Tier2）：达到 criticalThreshold (100k) 时
├─ 删除所有旧工具（不限类型）
├─ 按时间顺序，最旧的先删
└─ 目标：降到 warnThreshold 以下（统一目标线）
```

**设计考量**：

- 渐进式响应：先删低价值内容，必要时再删所有
- 统一目标线：Tier1 和 Tier2 都削减到 warnThreshold，提供 40k 缓冲空间
- 时序优先：最新内容通常更相关
- 职责分离：DCP 负责智能裁剪，OpenCode 会话压缩作为兜底机制

### 5.7 AI 工具：discard 与 extract

#### discard

**用途**：完全删除工具输出，不保留任何信息

**适用场景**：

- 噪音（与当前任务无关）
- 已完成的确认输出（git status, build success）
- 被新输出取代的旧输出
- 明确不需要的内容

#### extract

**用途**：提炼关键信息后删除原始输出

**适用场景**：

- 研究/分析完成，需要保留结论
- 大输出中只有部分相关
- 将来可能引用但不需要原文

**参数格式**：
使用元组数组 `[[id, distillation], ...]` 而非分离的两个数组，优势：

- ID 和摘要绑定在一起，无法出现数量不匹配
- 更省 token（无重复键名开销）
- 符合 AI 边分析边记录的工作流

### 5.8 小模型 Advisor（可选功能）

> 详细设计见 [docs/SMALL_MODEL_ADVISOR.md](docs/SMALL_MODEL_ADVISOR.md)

**原理**：使用 OpenCode 配置的 `small_model` 异步分析上下文，生成裁剪建议供主模型参考。

**工作流程**：

```
1. 触发条件：tokens >= tokenThreshold(40k) && prunableCount >= minPrunableCount(5) && 无待处理建议
2. 异步分析：创建临时会话 → 调用小模型 → 删除临时会话
3. 建议注入：下一轮注入 <advisor-suggestion> 到上下文（仅当 prunable-tools 列表也被注入时）
4. 主模型决策：接纳(调用 discard/extract) / 拒绝(忽略)
5. 反馈学习：被拒绝的内容获得保护期，影响后续建议
6. 过期清理：建议超过 SUGGESTION_EXPIRY_TURNS(2) 轮未消费则丢弃
```

**列表注入与建议注入的协同**：

Advisor 建议中包含 prunable-tools 列表中的 ID，因此建议必须与列表同时出现。为此：

- `insertPruneToolContext` 先执行，返回列表是否被注入
- 仅当列表已注入时，才注入 `<advisor-suggestion>`
- 当存在待投递的 advisor 建议时，即使 nudge urgency 为 "none"，也强制注入列表（advisor 认为需要裁剪本身就是 "on demand" 的合理理由）
- 这避免了"advisor 触发阈值(5工具) < 列表注入阈值(8工具)"窗口内 advisor 反复白跑的问题

**为什么选择"建议"而非"直接执行"**：

| 方案           | 优点                     | 缺点                                   |
| -------------- | ------------------------ | -------------------------------------- |
| 小模型直接裁剪 | 实现简单                 | 可能与主模型思路不一致，误删需要的内容 |
| 小模型提供建议 | 主模型保留决策权，更安全 | 需要注入机制，消耗少量主模型 token     |

选择建议模式，因为：

- 小模型能力有限，可能误判内容重要性
- 主模型可能正在进行多步操作，某些看似无用的内容实际仍在使用
- 建议被拒绝后可以反馈给小模型，提升后续判断质量

**反馈学习机制**：

```
被拒绝的内容 → 保护期 = 3 × rejectCount 轮

第 1 次拒绝：保护 3 轮
第 2 次拒绝：保护 6 轮
第 3 次拒绝：保护 9 轮
```

**Fallback 轮询机制**：

当小模型遇到速率限制(429)、服务不可用(503)或网络错误时，按配置顺序尝试备用模型：

- **首个成功 → 不动**：索引不变，下次继续用同一个模型
- **经过 fallback 才成功 → 切换**：索引更新到成功的模型
- **全部失败 → 移动**：索引移到下一个位置，避免反复卡在失败模型

**suppressNudge 机制**：

启用 Advisor 后默认禁用主模型的 normal/warn 级别 nudge 提示（`suppressNudge: true`），让主模型专注于用户任务，裁剪决策完全由 Advisor 建议驱动。critical 级别提示始终保留作为最后警告。

**与现有机制的关系**：

| 机制     | 职责                    | 触发方式       |
| -------- | ----------------------- | -------------- |
| 自动策略 | 低风险裁剪              | 每轮自动执行   |
| 激进裁剪 | 基于 token 预算自动裁剪 | 超过阈值时自动 |
| Advisor  | 语义分析，提供建议      | 超过阈值时异步 |
| AI 工具  | 最终执行裁剪            | 主模型主动调用 |

**配置**：

```jsonc
{
    "smallModelAdvisor": {
        "enabled": true, // 默认关闭
        "minPrunableCount": 5, // 比主模型阈值(8)更低
        "tokenThreshold": 40000, // 比 warnThreshold(60k) 更低
        "timeout": 10000,
        "contentPreviewLength": 200,
        "suppressNudge": true, // 禁用 normal/warn 级别 nudge
        "fallbackModels": [
            // 小模型调用失败时轮询的备用模型
            "openai/gpt-4o-mini",
            "anthropic/claude-3-haiku",
        ],
    },
}
```

---

## 6. 裁剪时机与触发机制

### 6.1 触发层次

```
                    Token 预算触发（主要）
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        warnThreshold            criticalThreshold
            (60k)                     (100k)
              │                         │
              ▼                         ▼
         warn 提示               critical 提示
        Tier1 裁剪                Tier2 裁剪
        (仅 error 工具)          (所有旧工具)
              │                         │
              ▼                         ▼
        目标: < 60k               目标: < 60k
                                        │
                                        ▼
                                裁剪后仍 >= 100k?
                                        │
                              ┌─────────┴─────────┐
                              ▼                   ▼
                             否                   是
                              │                   │
                              ▼                   ▼
                          正常流程           标记 exhausted
                                                  │
                                                  ▼
                                        后续轮次静默，直到
                                        计数器触发时再提醒


                    计数器触发（备用）
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   nudgeFrequency     N+ 工具数          discard/extract
      (每10个)           阈值               调用后
        │                  │                  │
        ▼                  ▼                  ▼
   normal 提示        normal 提示         重置计数器
  (或 critical        重置 exhausted
   若 exhausted)
```

### 6.2 提示紧急度决策流程

```
1. 如果 tokenBudget 启用：
   ├─ currentPrunableTokens >= criticalThreshold (100k)
   │    ├─ 如果 exhausted 且非计数器触发  → none（静默）
   │    └─ 否则  → critical
   ├─ currentPrunableTokens >= warnThreshold (60k)  → warn
   ├─ prunableToolCount >= PRUNABLE_TOOL_THRESHOLD  → normal
   └─ nudgeCounter >= nudgeFrequency  → normal

2. 如果 tokenBudget 禁用：
   └─ nudgeCounter >= nudgeFrequency  → normal

3. 其他情况 → none（不提示）

exhausted 状态：
- 设置：激进裁剪 Tier2 执行后，remainingTokens >= criticalThreshold
- 重置：tokens 降到 criticalThreshold 以下，或计数器触发时
```

### 6.3 阈值设计原理

| 阈值              | 值   | 设计原理                                                                           |
| ----------------- | ---- | ---------------------------------------------------------------------------------- |
| warnThreshold     | 60k  | 中等任务刚好触及，触发 warn + Tier1 (error 工具清理)，同时也是所有裁剪的统一目标线 |
| criticalThreshold | 100k | 业界共识的能力下降点，触发 critical + Tier2 (激进裁剪)                             |

**抑制机制**：

- 超过 100k 时首次触发 critical + 激进裁剪
- 如果裁剪后仍超标（可裁剪内容不足），标记 exhausted
- 后续轮次静默，直到计数器触发时再次提醒
- 避免频繁干扰超长任务（100k-200k 场景）

**为什么不持续警告**：

- 能力下降 ≠ 不可用，100k+ 只是效率降低
- 某些复杂任务（大型重构、长链分析）确实需要超长上下文
- OpenCode 自带会话压缩作为系统级兜底机制
- 强制裁剪可能删除用户正在使用的内容，违反用户优先原则

---

## 7. 正确性保证机制

### 7.1 稳定 ID 分配机制

**问题**：基于位置索引的 ID 分配会导致 ID 漂移——当某些工具输出被删除后，剩余工具的 ID 会发生变化，导致模型使用旧 ID 时可能误删其他内容。

```
问题场景（旧方案）：
T1: 工具输出 [A, B, C, D] → 列表 [0:A, 1:B, 2:C, 3:D]
T2: 删除 B → 工具输出 [A, C, D]
T3: 重新生成列表 → [0:A, 1:C, 2:D]  ← ID 1 现在指向 C！
T4: 模型用旧 ID 1 调用 Discard → 误删 C
```

**解决方案**：使用递增计数器分配稳定 ID，ID 一旦分配就不再复用。

```
稳定 ID 方案：
T1: 工具输出 [A, B, C, D] → 分配 ID [1:A, 2:B, 3:C, 4:D]
T2: 删除 B → 从映射表中移除 ID 2，但计数器不回退
T3: 新工具输出 E → 分配 ID 5:E（不复用 ID 2）
T4: 列表 [1:A, 3:C, 4:D, 5:E]  ← ID 保持稳定
T5: 模型用旧 ID 2 调用 Discard → "ID 2 不存在"（不会误删）
```

**核心数据结构**：

```typescript
interface DCPState {
    // ID 分配（从 1 开始，0 保留）
    nextToolId: number // 递增计数器，只增不减
    toolIdMap: Map<number, string> // numericId -> callId
    callIdToNumericId: Map<string, number> // callId -> numericId（反向索引）
}
```

**关键特性**：

1. **ID 不复用**：计数器只增不减，已分配的 ID 不会被重新分配
2. **裁剪后清理**：工具输出被裁剪后，从 `toolIdMap` 中删除对应条目
3. **内存可控**：`toolIdMap` 大小 = 当前未裁剪的工具数量
4. **压缩后重置**：检测到历史压缩后，重置计数器为 1，清空映射表

**ID 分配逻辑**：

```typescript
function getOrAssignToolId(state: DCPState, callId: string): number {
    // 检查是否已分配
    const existingId = state.callIdToNumericId.get(callId)
    if (existingId !== undefined) return existingId

    // 分配新 ID（递增，不复用）
    const newId = state.nextToolId++
    state.toolIdMap.set(newId, callId)
    state.callIdToNumericId.set(callId, newId)
    return newId
}
```

**裁剪时清理**：

```typescript
function onToolPruned(state: DCPState, callId: string): void {
    const numericId = state.callIdToNumericId.get(callId)
    if (numericId !== undefined) {
        state.toolIdMap.delete(numericId)
        state.callIdToNumericId.delete(callId)
    }
}
```

**压缩事件处理**：

OpenCode 提供了 `session.compacted` 事件，可以直接监听而无需自行检测：

```typescript
// hooks.ts - event hook
async event({ event }) {
    if (event.type === "session.compacted") {
        const sessionID = event.properties.sessionID
        const state = getSessionState(sessionID)

        // 重置 ID 分配状态
        state.nextToolId = 1
        state.toolIdMap.clear()
        state.callIdToNumericId.clear()
        state.unprunedIds.clear()
        state.listProvidedAfterReset = false  // 禁止裁剪，直到提供新列表

        logger.info(`[DCP] Session ${sessionID} compacted, ID state reset`)
    }
}
```

**重置后的裁剪保护**：

```typescript
function validatePruneRequest(state: DCPState): void {
    // 压缩重置后，必须先提供新列表，才允许裁剪
    if (!state.listProvidedAfterReset) {
        throw new Error(
            "Context was compressed. Please wait for a fresh <prunable-tools> list before pruning.",
        )
    }
}

// 在生成新列表后，标记为已提供
function onListProvided(state: DCPState): void {
    state.listProvidedAfterReset = true
}
```

**状态流转**：

```
┌─────────────────────────────────────────────────────────────────┐
│ 正常状态                                                        │
│   listProvidedAfterReset = true                                 │
│   → 允许裁剪                                                    │
│                                                                 │
│         ↓ 收到 session.compacted 事件                           │
│                                                                 │
│ 重置状态                                                        │
│   listProvidedAfterReset = false                                │
│   → 拒绝裁剪，返回错误提示                                       │
│                                                                 │
│         ↓ 生成并注入新列表                                       │
│                                                                 │
│ 恢复正常                                                        │
│   listProvidedAfterReset = true                                 │
│   → 允许裁剪                                                    │
└─────────────────────────────────────────────────────────────────┘
```

**重置后的裁剪保护**：

```typescript
function validatePruneRequest(state: DCPState): void {
    // 压缩重置后，必须先提供新列表，才允许裁剪
    if (!state.listProvidedAfterReset) {
        throw new Error(
            "Context was compressed. Please wait for a fresh <prunable-tools> list before pruning.",
        )
    }
}

// 在生成新列表后，标记为已提供
function onListProvided(state: DCPState): void {
    state.listProvidedAfterReset = true
}
```

**状态流转**：

```
┌─────────────────────────────────────────────────────────────────┐
│ 正常状态                                                        │
│   listProvidedAfterReset = true                                 │
│   → 允许裁剪                                                    │
│                                                                 │
│         ↓ 检测到压缩                                            │
│                                                                 │
│ 重置状态                                                        │
│   listProvidedAfterReset = false                                │
│   → 拒绝裁剪，返回错误提示                                       │
│                                                                 │
│         ↓ 生成并注入新列表                                       │
│                                                                 │
│ 恢复正常                                                        │
│   listProvidedAfterReset = true                                 │
│   → 允许裁剪                                                    │
└─────────────────────────────────────────────────────────────────┘
```

**实现位置**：

- ID 分配：`lib/messages/inject.ts` - buildPrunableToolsList()
- ID 验证：`lib/strategies/tools.ts` - executePruneOperation()
- 裁剪清理：`lib/strategies/tools.ts` - 裁剪完成后调用
- 压缩检测：`lib/hooks.ts` - messages.transform 开始时
- 状态管理：`lib/state/state.ts`

### 7.2 多层保护机制

```
第一层：工具名称保护
├─ 配置：tools.settings.protectedTools
├─ 默认：task, todowrite, write, edit, etc.
└─ 这些工具的输出永不被自动裁剪

第二层：文件路径模式保护
├─ 配置：protectedFilePatterns
├─ 支持 glob：*.json, src/core/**, **/test/*
└─ 匹配的文件路径相关工具不被裁剪

第三层：轮次保护
├─ 配置：turnProtection.enabled, turnProtection.turns
├─ 最近 N 轮内创建的工具不被裁剪
└─ 防止新鲜内容被过早删除
```

### 7.3 验证与错误处理

**输入验证**：

- ID 必须是数字字符串
- ID 必须在快照范围内
- extract 的 IDs 和 distillation 通过元组绑定，结构上保证匹配
- extract 不允许重复 ID

**幂等性保证**：

- 已裁剪的工具会被过滤
- 重复调用不产生副作用

**错误反馈**：

- 明确的错误消息帮助 AI 修正调用

### 7.4 压缩检测

**问题**：OpenCode 可能自动压缩历史消息，压缩后的消息不应被处理。

**解决方案**：

1. 检测消息的 `summary=true` 标记
2. 记录最后压缩时间戳 `lastCompaction`
3. 压缩后清空所有缓存，重新构建

---

## 8. 成本收益分析

### 8.1 成本项

| 成本类型            | 来源            | 估算               |
| ------------------- | --------------- | ------------------ |
| 系统提示词          | 每次请求都包含  | ~500-800 tokens    |
| prunable-tools 列表 | 每轮注入        | ~50-200 tokens     |
| nudge 提示          | 触发时注入      | ~50-100 tokens     |
| AI 工具调用         | discard/extract | 请求 + 响应 tokens |
| KV 缓存失效         | 消息内容修改    | 计算开销           |

### 8.2 收益项

| 收益类型     | 来源                 | 估算            |
| ------------ | -------------------- | --------------- |
| 自动策略节省 | 去重、超写、错误清除 | 20-40% 工具输出 |
| 激进裁剪节省 | 基于预算的自动裁剪   | 可变，防止溢出  |
| AI 主动裁剪  | discard/extract      | 50-80% 工具输出 |
| 质量保持     | 避免 100k+ 能力下降  | 难以量化        |

### 8.3 盈亏平衡分析

**简化模型**：

```
假设条件：
- DCP 开销（系统提示 + 列表）：~1000 tokens/轮
- 平均每轮工具输出：~2000 tokens
- 有效裁剪率：70%

每轮净收益 = 2000 * 70% - 1000 = 400 tokens

盈亏平衡点：从第 2 轮开始产生净收益
```

**实际情况**：

- 短对话（<5轮）：可能无净收益，但开销可接受
- 中等对话（5-20轮）：显著净收益
- 长对话（>20轮）：大幅净收益，且保持质量

---

## 9. 关键设计决策与取舍

### 9.1 阈值选择

| 决策              | 选项          | 选择 | 原因                                                                        |
| ----------------- | ------------- | ---- | --------------------------------------------------------------------------- |
| warnThreshold     | 30k/50k/60k   | 60k  | 给中等任务更多空间，减少打扰，同时作为统一目标线                            |
| criticalThreshold | 80k/100k/120k | 100k | 业界共识的能力下降点                                                        |
| nudgeFrequency    | 5/8/10        | 10   | token 预算是主要机制，计数器只是备用                                        |
| prunableToolCount | 5/8/10        | 8    | 8 个工具约 8k-16k tokens，更有意义（定义为 `PRUNABLE_TOOL_THRESHOLD` 常量） |

### 9.2 策略优先级

**选择**：先执行所有自动策略，再让 AI 处理剩余

**原因**：

- 自动策略无额外成本
- 减少 AI 需要处理的数量
- AI 只处理需要语义理解的决策

### 9.3 默认保护 write/edit

**选择**：write 和 edit 默认受保护，不被自动裁剪

**原因**：

- 文件修改可能需要回溯
- 错误恢复时需要知道做了什么
- 宁可保守也不丢失关键信息

**取舍**：可能保留不必要的内容，但安全性更重要

### 9.4 快照 vs 实时列表

**选择**：使用快照而非实时构建的列表

**原因**：

- 防止 ID 漂移导致误删
- 确保 AI 看到的列表与执行时一致

**取舍**：额外内存占用，但正确性是第一位

### 9.5 渐进式提示（系统不自动强制）

**选择**：normal → warn → critical 三级提示，系统不自动强制裁剪

**原因**：

- 避免系统自动删除用户正在使用的内容
- AI 根据 MUST/SHOULD 指令强度自主决策
- OpenCode 会话压缩作为系统级兜底，DCP 无需越界

### 9.6 extract 参数使用元组数组

**选择**：`[[id, distillation], ...]` 而非分离的 `ids[]` 和 `distillation[]`

**原因**：

- 结构上保证 ID 和摘要一一对应，无法不匹配
- 更省 token（无重复键名）
- 符合 AI 边分析边记录的工作流

**对比**：

```
// 分离数组 - 容易数量不匹配
ids: ["0", "1", "2"]
distillation: ["摘要1", "摘要2"]  // 少了一个！

// 元组数组 - 绑定在一起
[["0", "摘要1"], ["1", "摘要2"], ["2", "摘要3"]]
```

### 9.7 extract vs 仅 discard

**选择**：提供两种工具而非只有删除

**原因**：

- extract 保留关键信息，减少信息损失
- 适用于研究/分析场景
- 用户可选择性启用

**取舍**：extract 需要额外 token（distillation），但保留更多价值

### 9.8 清理历史 prunable-tools 注入

**选择**：每次注入新的 `<prunable-tools>` 前，清理历史消息中残留的旧注入

**原因**：

- Anthropic Prompt Caching 采用**前缀匹配**机制
- 历史消息中残留的 `<prunable-tools>` 内容每次都会变化（工具数量、ID 等）
- 这会破坏前缀缓存，导致 `cache_creation` 持续增长而 `cache_read` 无法复用
- 清理后，历史消息保持稳定，缓存命中率可从 ~30% 提升到 ~70%+

**取舍**：

- 需要遍历历史消息进行清理（O(N) 复杂度）
- 但收益显著：API 费用可节省 50-70%

**不影响功能的原因**：

- `<prunable-tools>` 是"当前可裁剪列表"的快照
- 历史快照已过期，AI 应使用最新列表
- ID 快照机制（9.4）确保了执行时的一致性

**按需注入**：

`tools.settings.injectPrunableTools` 支持三种模式：

| 模式      | 行为                                                        | 缓存影响 |
| --------- | ----------------------------------------------------------- | -------- |
| always    | 每次都注入 `<prunable-tools>` 列表                          | 高       |
| on_demand | nudge 触发时注入，或 advisor 有待投递建议时强制注入（默认） | 中       |
| on_warn   | 仅 warn/critical 时注入（advisor 待投递建议仍可强制注入）   | 低       |

**为什么 on_demand 是最佳选择**：

- **normal 级别注入**：当工具数量达到阈值时，模型可以主动裁剪
- **与系统提示一致**：系统提示要求 "8+ outputs → SHOULD prune"，需要列表才能执行
- **平衡缓存与功能**：仅在需要时注入，比 always 更节省缓存
- **Advisor 协同**：当 advisor 有建议待投递时强制注入列表，确保建议中的 ID 可被解析

---

## 10. 扩展与维护指南

### 10.1 添加新策略

1. 在 `lib/strategies/` 创建新文件
2. 实现策略函数，签名为：
    ```
    (state, logger, config, messages) => void
    ```
3. 在策略内部调用 `addPruneToolIds()` 标记裁剪
4. 在 `lib/strategies/index.ts` 导出
5. 在 `lib/hooks.ts` 的流水线中添加调用
6. 如需配置，在 `lib/config.ts` 添加类型和默认值

### 10.2 调整阈值

修改 `lib/config.ts` 中的 `defaultConfig`：

```
tokenBudget: {
  warnThreshold: 60000,       // warn 警告阈值，触发 Tier1，同时也是统一目标线
  criticalThreshold: 100000,  // critical 警告阈值，触发 Tier2
}
```

或通过配置文件覆盖。

### 10.3 添加新的保护规则

**保护工具名称**：

- 修改 `DEFAULT_PROTECTED_TOOLS` 列表
- 或在配置中添加到 `tools.settings.protectedTools`

**保护文件路径**：

- 在配置中添加到 `protectedFilePatterns`
- 支持 glob 模式

### 10.4 调试指南

**启用调试日志**：

```json
{ "debug": true }
```

**查看上下文快照**：
日志保存在 `~/.local/share/opencode/storage/plugin/dcp/logs/`

**使用 /dcp 命令**：

- `/dcp context`：查看 token 使用细分
- `/dcp stats`：查看累计统计

### 10.5 常见问题排查

| 问题               | 可能原因             | 排查方法                                       |
| ------------------ | -------------------- | ---------------------------------------------- |
| 工具没被裁剪       | 受保护               | 检查 protectedTools 和 protectedFilePatterns   |
| ID 无效错误        | 快照过期或 ID 漂移   | 检查是否有新消息导致列表变化，使用最新列表重试 |
| 工具名称不匹配错误 | 列表在生成后发生变化 | 使用最新 `<prunable-tools>` 列表中的 ID        |
| 提示太频繁         | 阈值太低             | 调整 warnThreshold 或 nudgeFrequency           |
| 上下文过大         | 需要手动裁剪         | 使用 discard/extract 或等待会话压缩            |

### 10.6 性能优化点

1. **缓存利用**：toolIdListCache、toolTokensCache 减少重复计算
2. **Set 查找**：toolIdSet 提供 O(1) 查找
3. **惰性计算**：token 计数仅在需要时计算；0 值不缓存以处理 running→completed 状态转换
4. **FIFO 淘汰**：toolParameters 超过 1000 时淘汰最旧条目
5. **哈希失效**：toolTokensCache 基于消息哈希 + tool state 摘要失效，覆盖同一消息内状态变化
6. **索引查找**：toolIdToPartCache 提供 O(1) 的工具位置查找，替代 O(N×M) 遍历
7. **状态清理**：定期清理 prune 状态中不再存在的 toolId，防止内存增长
8. **日志优化**：enabled 检查前置，避免禁用时的堆栈捕获开销
9. **Prompt Caching 优化**：清理历史消息中残留的 `<prunable-tools>` 块，保持消息内容稳定以最大化 Anthropic API 的前缀缓存命中率

---

## 附录：关键数据流

### A. 裁剪执行流程

```
标记阶段（strategies）          执行阶段（prune）
        │                              │
        ▼                              ▼
addPruneToolIds()              遍历 messages
        │                              │
        ▼                              ▼
state.prune.toolIds.push()     检查 toolIdSet.has(callID)
state.prune.toolIdSet.add()            │
        │                              ▼
        └───────────────────►   替换内容为占位符
                               "[Output pruned]"
                               "[pruned]"
```

### B. 提示注入流程

```
insertPruneToolContext()
        │
        ├──► cleanHistoricalPrunableTools()
        │           │
        │           ▼
        │    遍历历史消息
        │           │
        │           ▼
        │    移除 <prunable-tools> 块
        │    （保持前缀缓存稳定）
        │
        ├──► buildPrunableToolsList()
        │           │
        │           ▼
        │    遍历 toolParameters
        │           │
        │           ▼
        │    过滤：已裁剪、受保护、无内容
        │           │
        │           ▼
        │    保存快照到 prunableToolIdList
        │           │
        │           ▼
        │    生成数字 ID 列表
        │    "0: read, /path/file"
        │
        ├──► 计算 nudgeUrgency
        │           │
        │           ▼
        │    生成 nudgeString
        │
        └──► 注入到 messages（始终注入为 user 消息）
```
