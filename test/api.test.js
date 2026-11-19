import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventStore } from '../src/store/event-store.js';
import { LineageService } from '../src/domain/lineage-service.js';
import { createRouter } from '../src/http/router.js';

let base;
let server;
let svc;

before(async () => {
  const dir = path.join(tmpdir(), `lineage-api-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const store = new EventStore(dir);
  svc = new LineageService(store);
  await svc.init();
  server = http.createServer(createRouter(svc));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP: 对象与字段注册', async () => {
  const src = await call('POST', '/api/objects', { type: 'source', name: 'api_src' });
  assert.equal(src.status, 201);
  const fld = await call('POST', '/api/fields', {
    objectId: src.json.data.objectId,
    fieldName: 'col1',
    dataType: 'decimal',
  });
  assert.equal(fld.status, 201);
  const list = await call('GET', '/api/fields');
  assert.ok(list.json.data.some((f) => f.fieldName === 'col1'));

  // 重名冲突
  const dup = await call('POST', '/api/objects', { type: 'source', name: 'api_src' });
  assert.equal(dup.status, 409);
  // 坏 JSON
  const bad = await fetch(`${base}/api/objects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(bad.status, 400);
});

test('HTTP: 批次部分失败与循环引用返回结构化原因', async () => {
  const mdl = (await call('POST', '/api/objects', { type: 'model', name: 'api_mdl' })).json.data;
  const rpt = (await call('POST', '/api/objects', { type: 'report', name: 'api_rpt' })).json.data;
  const src = (await call('GET', '/api/objects')).json.data[0];
  const c1 = (await call('POST', '/api/fields', { objectId: mdl.objectId, fieldName: 'm1', dataType: 'decimal' })).json.data;
  const c2 = (await call('POST', '/api/fields', { objectId: mdl.objectId, fieldName: 'm2', dataType: 'decimal' })).json.data;
  const kpi = (await call('POST', '/api/fields', { objectId: rpt.objectId, fieldName: 'k1', dataType: 'decimal' })).json.data;
  const srcCol = (await call('GET', '/api/fields')).json.data.find((f) => f.fieldName === 'col1');

  const res = await call('POST', '/api/lineage/batches', {
    entries: [
      { sourceFieldId: srcCol.fieldId, targetFieldId: c1.fieldId, transformExpression: 'col1' },
      { sourceFieldId: c1.fieldId, targetFieldId: c2.fieldId, transformExpression: 'm1' },
      { sourceFieldId: c2.fieldId, targetFieldId: c1.fieldId, transformExpression: 'm2' }, // 成环
      { sourceFieldId: 'missing', targetFieldId: kpi.fieldId, transformExpression: 'x' }, // 字段不存在
    ],
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.data.committedCount, 2);
  assert.equal(res.json.data.failedCount, 2);
  assert.ok(res.json.data.results.some((r) => /循环引用/.test(r.reason)));
  assert.ok(res.json.data.results.some((r) => /来源字段不存在/.test(r.reason)));
});

test('HTTP: 改名/删除 -> 影响分析 -> 迁移状态机 -> 历史快照隔离', async () => {
  const fields = (await call('GET', '/api/fields')).json.data;
  const srcCol = fields.find((f) => f.fieldName === 'col1');
  const renamed = await call('POST', `/api/fields/${srcCol.fieldId}/rename`, { newName: 'col1_v2' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.data.impact.affectedFields.length >= 1, true);

  // 迁移单状态机：阻断态不能直接 done
  const mig = renamed.json.data.impact.migrations[0];
  const illegal = await call('POST', `/api/migrations/${mig.edgeId}/status`, { status: 'done' });
  assert.equal(illegal.status, 409);
  await call('POST', `/api/migrations/${mig.edgeId}/status`, {
    status: 'pending',
    reason: '人工确认口径',
  });
  const done = await call('POST', `/api/migrations/${mig.edgeId}/status`, { status: 'done' });
  assert.equal(done.json.data.status, 'done');

  // 影响列表
  const impacts = await call('GET', '/api/impacts');
  assert.ok(impacts.json.data.length >= 1);

  // 历史快照：v1 血缘不受后续事件影响
  const v1 = await call('GET', '/api/lineage/graph?atLineageVersion=1');
  const cur = await call('GET', '/api/lineage/graph');
  assert.equal(v1.json.data.snapshotAt, 1);
  assert.ok(cur.json.data.edges.length >= v1.json.data.edges.length);

  // 删除字段
  const del = await call('POST', `/api/fields/${srcCol.fieldId}/delete`, { reason: '废弃' });
  assert.equal(del.status, 200);
  const gone = (await call('GET', '/api/fields')).json.data.find((f) => f.fieldId === srcCol.fieldId);
  assert.equal(gone.status, 'deleted');
});

test('HTTP: 版本差异与聚焦血缘图', async () => {
  const diff = await call('GET', '/api/versions/diff');
  assert.equal(diff.status, 200);
  assert.ok('edgeAdded' in diff.json.data);
  const fields = (await call('GET', '/api/fields')).json.data;
  const focus = await call('GET', `/api/lineage/graph?fieldId=${fields[0].fieldId}`);
  assert.equal(focus.status, 200);
  assert.ok(Array.isArray(focus.json.data.nodes));
});

test('HTTP: 错误路由与 404 字段', async () => {
  const nf = await call('GET', '/api/fields/fld_nope');
  assert.equal(nf.status, 404);
  const noRoute = await call('GET', '/api/nonsense');
  assert.equal(noRoute.status, 404);
});

test('HTTP: 健康检查', async () => {
  const h = await call('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(typeof h.json.data.lineageVersion, 'number');
});
