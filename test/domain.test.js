import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { EventStore } from '../src/store/event-store.js';
import { LineageService, MIGRATION_STATUS } from '../src/domain/lineage-service.js';
import { tokenizeExpression } from '../src/domain/expression.js';
import { detectCycle, buildFieldGraph } from '../src/domain/graph.js';
import { foldAtLineageVersion } from '../src/domain/reducer.js';

async function newService() {
  const dir = path.join(tmpdir(), `lineage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const store = new EventStore(dir);
  const svc = new LineageService(store);
  await svc.init();
  return { svc, dir };
}

async function seedMini(svc) {
  const src = await svc.registerObject({ type: 'source', name: 'src_t' });
  const mdl = await svc.registerObject({ type: 'model', name: 'mdl_t' });
  const rpt = await svc.registerObject({ type: 'report', name: 'rpt_t' });
  const a = await svc.registerField({ objectId: src.objectId, fieldName: 'a', dataType: 'decimal' });
  const b = await svc.registerField({ objectId: src.objectId, fieldName: 'b', dataType: 'decimal' });
  const x = await svc.registerField({ objectId: mdl.objectId, fieldName: 'x', dataType: 'decimal' });
  const y = await svc.registerField({ objectId: mdl.objectId, fieldName: 'y', dataType: 'decimal' });
  const k = await svc.registerField({ objectId: rpt.objectId, fieldName: 'kpi', dataType: 'decimal' });
  return { src, mdl, rpt, a, b, x, y, k };
}

test('表达式解析：识别标识符、函数与字面量', () => {
  const t = tokenizeExpression("COALESCE(city_gmv, 0) + ROUND(daily_gmv * 0.01, 2) AND 'x'");
  assert.deepEqual(t.identifiers.sort(), ['city_gmv', 'daily_gmv']);
  assert.ok(t.keywords.includes('COALESCE'));
  assert.ok(t.literals.includes('0'));
});

test('血缘批次注册：合法条目提交，非法条目部分失败，失败不影响其他条目', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  const res = await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
    { sourceFieldId: 'nonexistent', targetFieldId: m.y.fieldId, transformExpression: 'a' },
    { sourceFieldId: m.b.fieldId, targetFieldId: m.y.fieldId, transformExpression: 'unknown_col + b' },
    { sourceFieldId: m.b.fieldId, targetFieldId: m.y.fieldId, transformExpression: 'b' },
  ]);
  assert.equal(res.committedCount, 2);
  assert.equal(res.failedCount, 2);
  assert.equal(res.lineageVersion, 1);
  assert.equal(res.results[0].status, 'ok');
  assert.match(res.results[1].reason, /来源字段不存在/);
  assert.match(res.results[2].reason, /无法解析的标识符/);
  // 失败后服务仍可继续登记
  const again = await svc.registerLineageBatch([
    { sourceFieldId: m.x.fieldId, targetFieldId: m.k.fieldId, transformExpression: 'x' },
  ]);
  assert.equal(again.committedCount, 1);
});

test('重复登记被跳过，不产生新版本边', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
  ]);
  const dup = await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
  ]);
  assert.equal(dup.committedCount, 0);
  assert.equal(dup.skippedCount, 1);
  assert.equal(dup.batchId, null);
  assert.equal(svc.getCurrentState().lineageVersion, 1);
});

test('循环引用：批次内成环被拒绝，其余无环边照常提交', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  // 先建 a -> x
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
  ]);
  // 本批：x -> y 合法；y -> x 与既有 x->y 成环（同批次内 x->y, y->x 直接 2 环）
  const res = await svc.registerLineageBatch([
    { sourceFieldId: m.x.fieldId, targetFieldId: m.y.fieldId, transformExpression: 'x' },
    { sourceFieldId: m.y.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'y' },
    { sourceFieldId: m.b.fieldId, targetFieldId: m.k.fieldId, transformExpression: 'b' },
  ]);
  assert.ok(res.results.some((r) => r.status === 'failed' && /循环引用/.test(r.reason)));
  assert.ok(res.committedCount >= 1);
  // 图中不得存在环
  const graph = buildFieldGraph(svc.getCurrentState());
  assert.equal(detectCycle(graph, []), null);
});

test('跨批次长环也被检测（a->x->y->a）', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
    { sourceFieldId: m.x.fieldId, targetFieldId: m.y.fieldId, transformExpression: 'x' },
  ]);
  const res = await svc.registerLineageBatch([
    { sourceFieldId: m.y.fieldId, targetFieldId: m.a.fieldId, transformExpression: 'y' },
  ]);
  assert.equal(res.failedCount, 1);
  assert.match(res.results[0].reason, /循环引用/);
});

test('改名：字段版本递增，生成下游影响与 pending 迁移，名称历史保留', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
    { sourceFieldId: m.x.fieldId, targetFieldId: m.k.fieldId, transformExpression: 'x' },
  ]);
  const { impact } = await svc.renameField(m.a.fieldId, 'a_renamed', '治理改名');
  const field = svc.getField(m.a.fieldId);
  assert.equal(field.fieldVersion, 2);
  assert.equal(field.name, 'a_renamed');
  assert.equal(field.nameHistory[0].fromName, 'a');
  assert.equal(impact.affectedFieldCount, 2);
  assert.deepEqual(
    impact.affectedObjects.map((o) => o.objectName).sort(),
    ['mdl_t', 'rpt_t'],
  );
  const mig = impact.migrations[0];
  assert.equal(mig.status, MIGRATION_STATUS.BLOCKED); // 同对象内无同名字段可自动替换
  assert.ok(mig.blockingReasons.length > 0);
  // 阻断解除需要说明
  await assert.rejects(() => svc.updateMigration(mig.edgeId, 'pending'), /处理说明/);
  await svc.updateMigration(mig.edgeId, 'pending', '人工确认');
  await svc.updateMigration(mig.edgeId, 'done');
  const done = svc.getCurrentState().migrationIndex.get(mig.edgeId).migration;
  assert.equal(done.status, 'done');
  assert.ok(done.history.length >= 3);
});

test('删除：复合表达式迁移被阻断，无替代字段时给出原因；无下游字段则零迁移单', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a + b' },
  ]);
  const { impact } = await svc.deleteField(m.a.fieldId, '口径废弃');
  const field = svc.getField(m.a.fieldId);
  assert.equal(field.status, 'deleted');
  assert.equal(field.fieldVersion, 2);
  const mig = impact.migrations[0];
  assert.equal(mig.status, 'blocked');
  assert.ok(mig.blockingReasons.some((r) => /多个字段/.test(r)));
  assert.equal(impact.progress.completionRate, 0);

  // 无下游字段删除
  const other = await svc.deleteField(m.b.fieldId);
  assert.equal(other.impact.migrations.length, 0);
  assert.equal(other.impact.affectedFieldCount, 0);
});

test('替代字段改引：remap 后迁移解除阻断并记录替代字段', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a + b' },
  ]);
  const { impact } = await svc.deleteField(m.a.fieldId);
  const mig = impact.migrations[0];
  assert.equal(mig.status, 'blocked');
  const updated = await svc.remapMigration(mig.edgeId, m.b.fieldId, 'b 为同类型替代');
  assert.equal(updated.remapped, true);
  assert.equal(updated.altSourceFieldId, m.b.fieldId);
  assert.equal(updated.status, MIGRATION_STATUS.PENDING);
});

test('历史版本隔离：v1 快照不被 v2 血缘覆盖，边保留注册时钉选版本', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  const b1 = await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
  ]);
  const b2 = await svc.registerLineageBatch([
    { sourceFieldId: m.x.fieldId, targetFieldId: m.k.fieldId, transformExpression: 'x' },
  ]);
  assert.equal(b2.lineageVersion, 2);
  const v1 = svc.getSnapshot(1);
  const cur = svc.getSnapshot(2);
  assert.equal(v1.edges.length, 1);
  assert.equal(cur.edges.length, 2);
  assert.equal(v1.edges[0].sourceFieldVersion, 1);
  assert.equal(v1.edges[0].targetFieldVersion, 1);

  // 改名后重新折叠 v1：边依然存在且钉选版本不变，漂移标记可在装饰视图中看到
  await svc.renameField(m.a.fieldId, 'a2');
  const v1Again = svc.getSnapshot(1);
  assert.equal(v1Again.edges.length, 1);
  assert.equal(v1Again.edges[0].sourceFieldVersion, 1);
  const decorated = svc.decorateState(v1Again);
  assert.equal(decorated.edges[0].sourceVersionDrift, true);

  // 直接用 reducer 折叠原始事件也一致
  const events = await svc.store.readAll();
  const folded = foldAtLineageVersion(events, 1);
  assert.equal(folded.edges.length, 1);
  assert.equal(folded.lineageVersion, 1);

  // 超出范围的版本报错
  assert.throws(() => svc.getSnapshot(99), /不存在/);
});

test('版本差异：列出新增边与字段改名/删除', async () => {
  const { svc } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
  ]);
  await svc.registerLineageBatch([
    { sourceFieldId: m.x.fieldId, targetFieldId: m.k.fieldId, transformExpression: 'x' },
  ]);
  await svc.renameField(m.a.fieldId, 'a_new');
  const diff = svc.diffVersions(1, 2);
  assert.equal(diff.edgeAdded.length, 1);
  assert.equal(diff.edgeRemoved.length, 0);
  const diffAll = svc.diffVersions(0, 2);
  assert.equal(diffAll.edgeAdded.length, 2);
  assert.ok(diffAll.fieldChanges.some((c) => c.change === 'renamed' && c.toName === 'a_new'));
});

test('事件存储仅追加：重启服务后状态完整恢复', async () => {
  const { svc, dir } = await newService();
  const m = await seedMini(svc);
  await svc.registerLineageBatch([
    { sourceFieldId: m.a.fieldId, targetFieldId: m.x.fieldId, transformExpression: 'a' },
  ]);
  await svc.renameField(m.a.fieldId, 'aa');

  const store2 = new EventStore(dir);
  const svc2 = new LineageService(store2);
  await svc2.init();
  const state = svc2.getCurrentState();
  assert.equal(state.objects.size, 3);
  assert.equal(state.fields.size, 5);
  assert.equal(state.edges.length, 1);
  assert.equal(state.lineageVersion, 1);
  assert.equal(state.impacts.length, 1);
  assert.equal(state.fields.get(m.a.fieldId).name, 'aa');
  await fs.rm(dir, { recursive: true, force: true });
});
