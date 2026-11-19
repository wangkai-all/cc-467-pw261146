# 字段级血缘登记与影响分析

零依赖 Node.js 实现（仅使用 `node:http` / `node:test`，前端原生 HTML/SVG/JS）。
覆盖：来源字段 → 转换表达式 → 模型列 → 报表指标的**字段级、版本化**血缘，
以及字段改名/删除时的影响分析、替代字段推荐、阻断原因与迁移进度跟踪。

## 快速开始

```bash
npm run seed     # 播种演示数据（5 对象 / 19 字段 / 10 条血缘 / 4 次影响分析）
npm start        # http://localhost:3000
npm test         # 17 个后端测试（领域层 + HTTP 端到端）
```

环境变量：`PORT`（默认 3000）、`LINEAGE_DATA_DIR`（默认 `./data`）。

## 核心设计

### 1. 事件溯源 + 仅追加存储（`src/store/event-store.js`）

所有变更都是不可变事件，顺序写入 `data/events.jsonl`：

| 事件 | 含义 |
| --- | --- |
| `OBJECT_REGISTERED` / `FIELD_REGISTERED` | 对象/字段注册（objectVersion / fieldVersion 从 1 起） |
| `FIELD_RENAMED` / `FIELD_DELETED` | 字段版本 +1，旧名称进入 `nameHistory`，删除仅打标记 |
| `LINEAGE_REGISTERED` | 一个批次产生一个新的 `lineageVersion`，边不可变 |
| `IMPACT_ANALYZED` | 改名/删除触发的影响分析与迁移单 |
| `MIGRATION_STATUS_CHANGED` / `MIGRATION_REMAPPED` | 迁移状态流转与替代字段改引 |

当前状态由事件折叠得到（`src/domain/reducer.js`）。`foldAtLineageVersion(events, v)`
只纳入 `lineageVersion <= v` 的血缘批次，因此**历史版本查询不会被新血缘覆盖**。

### 2. 版本钉选的血缘边

每条边在注册时钉住两端当时的字段版本：

```json
{
  "edgeId": "edge_xxx",
  "sourceFieldId": "fld_a", "sourceFieldVersion": 1,
  "targetFieldId": "fld_b", "targetFieldVersion": 1,
  "transformExpression": "COALESCE(ods_orders.order_amount, 0)",
  "expressionRefs": [{"objectId":"obj_x","fieldName":"order_amount"}]
}
```

字段后续改名/删除不会修改边；装饰视图计算 `sourceVersionDrift / targetVersionDrift`
标记版本漂移，血缘图中以黄色虚线提示。

### 3. 注册校验与部分失败（`registerLineageBatch`）

批次按两阶段处理，单条失败不影响其他条目：

1. 逐条解析：字段定位（fieldId / `对象.字段` / 裸名）、表达式标识符解析
   （`src/domain/expression.js`，函数与 SQL 关键字白名单，字面量剔除）、
   来源与表达式引用一致性、自引用、重复边跳过；
2. 全量循环引用检测：存量边 + 本批候选边叠加后 DFS 三色标记
   （`src/domain/graph.js`），成环条目带完整环路径失败，其余无环边照常提交。

返回每条条目的 `status`（ok / failed / skipped）与原因；全部失败时不产生新血缘版本。

### 4. 影响分析（改名/删除自动触发）

- `downstreamClosure` 计算全部下游字段与传播路径（含层级 distance）；
- 为每条**直接消费**该字段的边生成迁移单；
- 同对象内按数据类型/名称相似度评分推荐**替代字段**；
- 阻断原因示例：无同类型存活字段、复合表达式引用多字段语义无法保持、改名后无同名字段；
- 迁移状态机：`blocked → pending → in_progress → done`（另有 `wont_migrate`），
  非法流转返回 409，阻断解除必须填写说明（400），全部流转写入 `history`。

### 5. 页面（`public/`）

- **血缘图**：SVG 分层布局（来源→模型→报表），点击节点聚焦上下游，
  点击边查看钉选版本/表达式/漂移/迁移状态；支持按历史血缘版本切换快照；
- **版本差异**：任意两个血缘版本间的边增删与字段新建/改名/删除（含字段版本区间）；
- **影响与迁移**：受影响对象/字段、传播路径、阻断原因、替代字段一键改引、
  迁移进度条与状态流转操作历史；
- **登记台**：对象/字段注册、批次登记（实时展示部分失败结果）、改名/删除。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/objects` / `/api/fields` | 注册对象/字段 |
| POST | `/api/lineage/batches` | 批次血缘登记（部分失败 + 循环检测） |
| GET | `/api/lineage/graph?atLineageVersion=v` | 全图/历史快照 |
| GET | `/api/lineage/graph?fieldId=...` | 字段聚焦子图 |
| GET | `/api/versions/diff?fromVersion=&toVersion=` | 版本差异 |
| POST | `/api/fields/:id/rename` `/delete` | 改名/删除（返回影响分析） |
| GET | `/api/impacts` `/api/impacts/:id` | 影响分析 |
| POST | `/api/migrations/:edgeId/status` | 迁移状态流转 |
| POST | `/api/migrations/:edgeId/remap` | 替代字段改引 |

## 目录结构

```
src/
  store/event-store.js    仅追加事件存储
  domain/
    reducer.js            事件折叠（当前态/历史快照）
    graph.js              名称索引、环检测、上下游闭包
    expression.js         表达式词法解析与字段引用解析
    lineage-service.js    领域服务（注册/影响/迁移/差异）
    errors.js  ids.js
  http/router.js  server.js
  seed.js
public/                   前端页面（零构建）
test/                     node:test 测试
```
