# 采集规划层：按目标组织请求、按回执扣减、按缺口重取

合作资料库按字段树与返回对象数量计费，不按 HTTP 次数。规划层位于 `src/planner.mjs`（纯函数）与 `src/collect.mjs`（作业执行），把"要哪些实体、哪些必需字段、哪些可选字段"翻译成发送前即可解释的请求计划，并在执行中按真实回执扣减预算。

## 输入与产物

调用方提供采集目标：`{ids, required, optional, role}` 与预算。来源能力表（`GET /inventory`，经 `getCapabilities` 整理）提供字段代价、`dependencies` 字段依赖、`incompatible` 互斥展开、`roles` 角色权限与实体→机构目录。

`planCollection` 的产物：

- `batches`：每批的实体、字段、预计代价与原因。依赖闭包自动补齐（`history` 带上 `name`），互斥字段自动拆批，单批代价受 `maxBatchCost` 封顶。
- `sharedFetches`：同一机构的共享资料经 `/organizations/{orgId}` 一次领取，覆盖所有关联实体，不按实体重复计费。
- `unsatisfiable`：预算内或权限内无法满足的**必需**字段，逐条带原因（不存在、角色无权、预算不足、实体不在目录）。绝不静默删字段。
- `skippedOptional`：被放弃的可选字段及原因。
- `explanations`：每条取舍的说明；`formatPlan` 渲染为可审阅文本。

## 执行与真实扣减

`runCollection({source, goal, budget, maxBatchCost, maxAttempts, maxRounds, cache, statePath, signal, onEvent})`：

1. 读取能力表 → 规划 → 共享领取 → 逐批查询。每个请求的 `maxCost` 按计划报价封顶，来源临时涨价会得到 402 而不是超扣。
2. 扣减以来源回执为准，不以计划估值为准；部分字段失败时来源仍计费，已取得的字段保留，缺口记入下一轮。
3. 缓存键 = 授权角色 + 能力版本 + 实体：管理员取到的字段不会流向普通账号；能力版本迁移时旧版本条目整体失效。
4. 每批之后状态快照写入 `statePath`（建议 `.local/` 下），`resumeCollection` 从断点继续，可 `additionalBudget` 追加预算；已取字段不重复计费。

## 何时重新规划、何时停止

重新规划的触发点（每次都先重读能力表再规划，绝不原样重发）：

- `402 报价超限`：字段代价在响应前上涨；
- `409 能力版本不符`：缓存按版本失效后重规划；
- `422/400 计划被拒`：能力表与本地假设漂移；
- 部分字段失败：只把仍有价值的缺口（必需未满足、或可选且预算可及）带入下一轮，每个字段最多 `maxAttempts` 次（默认 2）；
- 作业恢复：从中断点以最新能力表重规划。

停止条件：

- 目标达成（`complete`，仅当必需字段全部满足）；
- 预算不足或能力不满足（`partial`，`unmet` 逐条列出必需缺口及原因）；
- 来源字段持续不可用（达到尝试上限，`stopReason: source-field-unavailable`）；
- 重规划轮次超过 `maxRounds`（默认 6，`stopReason: replan-limit`，防止在代价/版本抖动中空转）；
- 外部 `AbortSignal`（`aborted`，状态已落盘可恢复）；
- 来源故障（`failed`，状态已落盘可恢复）。

`complete` 只在必需字段全部取得时出现；预算不足永远得到 `partial` 加明确的 `unmet` 清单，不会被包装成完整成功。

## 可观测性

`onEvent` 事件流：`plan`（发送前的计划与解释）→ `shared`/`receipt`（共享领取与逐批真实扣减）→ `gap`（缺口及尝试次数）→ `replan`（重规划及原因）→ `status`（终态）。作业结果同时携带请求计划（`plans`）、实际花费（`spend.receipts`）与每条资料的字段完整度（`completeness.perEntity`）。

## 演示

`npm run demo:collect` 在同一本地来源上跑八个场景：两种角色 × 不同预算的取舍、字段代价中途上涨、能力版本中途迁移、中止与恢复、预算不足不伪装成功。
