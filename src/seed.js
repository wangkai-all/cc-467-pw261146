/**
 * 演示数据播种脚本：
 *   1) 源表 / 模型 / 报表三类对象与字段（含字段版本）
 *   2) 两批血缘登记（lineageVersion 1、2），边钉住字段版本与转换表达式
 *   3) 改名 -> 影响分析 + 迁移单
 *   4) 删除 -> 阻断型迁移（无替代字段 / 多标识符表达式）
 * 重新运行会清空事件存储（仅用于演示）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './store/event-store.js';
import { LineageService } from './domain/lineage-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.LINEAGE_DATA_DIR ?? path.join(__dirname, '..', 'data');

async function main() {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  const store = new EventStore(DATA_DIR);
  const svc = new LineageService(store);
  await svc.init();

  // ---- 对象 ----
  const orders = await svc.registerObject({ type: 'source', name: 'ods_orders', description: '订单源表' });
  const users = await svc.registerObject({ type: 'source', name: 'ods_users', description: '用户源表' });
  const dwd = await svc.registerObject({ type: 'model', name: 'dwd_order_detail', description: '订单明细模型' });
  const dws = await svc.registerObject({ type: 'model', name: 'dws_sales_summary', description: '销售汇总模型' });
  const report = await svc.registerObject({ type: 'report', name: 'rpt_sales_dashboard', description: '销售看板报表' });

  // ---- 字段 ----
  const f = async (objectId, fieldName, dataType, description = '') =>
    svc.registerField({ objectId, fieldName, dataType, description });

  const orderId = await f(orders.objectId, 'order_id', 'bigint');
  const userId = await f(orders.objectId, 'user_id', 'bigint');
  const amount = await f(orders.objectId, 'order_amount', 'decimal');
  const status = await f(orders.objectId, 'order_status', 'string');
  const createdAt = await f(orders.objectId, 'created_at', 'timestamp');
  const uId = await f(users.objectId, 'user_id', 'bigint');
  const uName = await f(users.objectId, 'user_name', 'string');
  const uCity = await f(users.objectId, 'city', 'string');

  const dOrderId = await f(dwd.objectId, 'order_id', 'bigint');
  const dUserId = await f(dwd.objectId, 'user_id', 'bigint');
  const dAmount = await f(dwd.objectId, 'gmv_amount', 'decimal');
  const dCity = await f(dwd.objectId, 'city', 'string');
  const dDate = await f(dwd.objectId, 'dt', 'date');

  const sGmv = await f(dws.objectId, 'daily_gmv', 'decimal');
  const sOrderCnt = await f(dws.objectId, 'order_count', 'bigint');
  const sCityGmv = await f(dws.objectId, 'city_gmv', 'decimal');

  const rGmv = await f(report.objectId, 'gmv_kpi', 'decimal');
  const rCnt = await f(report.objectId, 'order_count_kpi', 'bigint');
  const rCity = await f(report.objectId, 'city_gmv_metric', 'decimal');

  // ---- 第一批血缘（lineageVersion=1）----
  // 跨对象存在重名字段（如两个 user_id / order_id），表达式使用 全限定名 对象.字段 消除歧义
  const batch1 = await svc.registerLineageBatch([
    { sourceFieldId: orderId.fieldId, targetFieldId: dOrderId.fieldId, transformExpression: 'ods_orders.order_id' },
    { sourceFieldId: userId.fieldId, targetFieldId: dUserId.fieldId, transformExpression: 'ods_orders.user_id' },
    { sourceFieldId: amount.fieldId, targetFieldId: dAmount.fieldId, transformExpression: 'COALESCE(ods_orders.order_amount, 0)' },
    { sourceFieldId: uCity.fieldId, targetFieldId: dCity.fieldId, transformExpression: 'ods_users.city' },
    { sourceFieldId: dAmount.fieldId, targetFieldId: sGmv.fieldId, transformExpression: 'SUM(dwd_order_detail.gmv_amount)' },
    { sourceFieldId: dOrderId.fieldId, targetFieldId: sOrderCnt.fieldId, transformExpression: 'COUNT(DISTINCT dwd_order_detail.order_id)' },
    { sourceFieldId: dCity.fieldId, targetFieldId: sCityGmv.fieldId, transformExpression: 'SUM(dwd_order_detail.gmv_amount) GROUP BY dwd_order_detail.city' },
  ]);
  console.log('批次1:', {
    lineageVersion: batch1.lineageVersion,
    committed: batch1.committedCount,
    failed: batch1.failedCount,
  });

  // ---- 第二批血缘（lineageVersion=2）：报表指标，含复合表达式 ----
  const batch2 = await svc.registerLineageBatch([
    { sourceFieldId: sGmv.fieldId, targetFieldId: rGmv.fieldId, transformExpression: 'dws_sales_summary.daily_gmv' },
    { sourceFieldId: sOrderCnt.fieldId, targetFieldId: rCnt.fieldId, transformExpression: 'dws_sales_summary.order_count' },
    {
      sourceFieldId: sCityGmv.fieldId,
      targetFieldId: rCity.fieldId,
      transformExpression: 'COALESCE(dws_sales_summary.city_gmv, 0) + ROUND(dws_sales_summary.daily_gmv * 0.01, 2)',
    },
  ]);
  console.log('批次2:', {
    lineageVersion: batch2.lineageVersion,
    committed: batch2.committedCount,
    failed: batch2.failedCount,
  });

  // ---- 改名：ods_orders.user_id -> buyer_id（同类型替代字段存在）----
  const renameResult = await svc.renameField(userId.fieldId, 'buyer_id', '数据治理统一命名');
  console.log('\n改名影响分析:', {
    impactId: renameResult.impact.impactId,
    受影响字段数: renameResult.impact.affectedFieldCount,
    受影响对象: renameResult.impact.affectedObjects.map((o) => o.objectName),
    迁移单数: renameResult.impact.migrations.length,
    进度: renameResult.impact.progress,
  });

  // ---- 删除：ods_orders.order_status（无下游，无迁移单场景对照）----
  const deleteNoDownstream = await svc.deleteField(status.fieldId, '废弃状态字段');
  console.log('\n无下游字段删除:', {
    受影响字段数: deleteNoDownstream.impact.affectedFieldCount,
    迁移单数: deleteNoDownstream.impact.migrations.length,
  });

  // ---- 删除：order_amount（有下游 + 复合表达式 -> 阻断）----
  const deleteResult = await svc.deleteField(amount.fieldId, '金额口径迁移到新表');
  console.log('\n删除影响分析:', {
    impactId: deleteResult.impact.impactId,
    受影响字段: deleteResult.impact.affectedFields.map((x) => `${x.objectName}.${x.fieldName}`),
    迁移状态: deleteResult.impact.migrations.map((m) => ({
      目标: m.targetFieldName,
      状态: m.status,
      阻断原因: m.blockingReasons,
      替代候选: m.alternatives.map((a) => a.name),
    })),
    进度: deleteResult.impact.progress,
  });

  // 演示：处理一条阻断迁移（人工确认解除阻断 -> 进行中 -> 完成）
  const blocked = deleteResult.impact.migrations.find((m) => m.status === 'blocked');
  if (blocked) {
    await svc.updateMigration(blocked.edgeId, 'pending', '人工确认金额口径保持不变，使用新表字段替代');
    await svc.updateMigration(blocked.edgeId, 'in_progress');
    await svc.updateMigration(blocked.edgeId, 'done');
    console.log('\n迁移单已人工推进至 done:', blocked.edgeId);
  }

  // ---- 删除：city_gmv（被报表复合表达式引用 -> 阻断型迁移，展示阻断原因）----
  const blockedDelete = await svc.deleteField(sCityGmv.fieldId, '城市口径下线');
  console.log('\n复合表达式删除（阻断演示）:', {
    受影响字段: blockedDelete.impact.affectedFields.map((x) => `${x.objectName}.${x.fieldName}`),
    迁移状态: blockedDelete.impact.migrations.map((m) => ({
      目标: m.targetFieldName,
      状态: m.status,
      阻断原因: m.blockingReasons,
      替代候选数: m.alternatives.length,
    })),
  });

  // ---- 历史版本校验：v1 快照不应包含 v2 的报表边 ----
  const v1 = svc.getSnapshot(1);
  const v2 = svc.getSnapshot(2);
  console.log('\n历史版本隔离校验:', {
    v1边数: v1.edges.length,
    v2边数: v2.edges.length,
    v1包含报表指标边: v1.edges.some((e) => e.targetObjectId === report.objectId),
    v2包含报表指标边: v2.edges.some((e) => e.targetObjectId === report.objectId),
  });

  console.log('\n播种完成。启动: npm start，访问 http://localhost:3000');
}

main().catch((err) => {
  console.error('播种失败:', err);
  process.exit(1);
});
