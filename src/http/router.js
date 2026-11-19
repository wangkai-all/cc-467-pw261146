import { ValidationError } from '../domain/errors.js';

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

export const ok = (res, body) => json(res, 200, { ok: true, data: body });
export const created = (res, body) => json(res, 201, { ok: true, data: body });
export const fail = (res, err) => {
  if (err instanceof ValidationError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'CONFLICT' ? 409 : 400;
    return json(res, status, { ok: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  return json(res, 500, { ok: false, error: { code: 'INTERNAL', message: err.message } });
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}

/**
 * @param {import('../domain/lineage-service.js').LineageService} service
 */
export function createRouter(service) {
  return async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const q = url.searchParams;
    try {
      // ---------- 对象 ----------
      if (req.method === 'POST' && p === '/api/objects') {
        return created(res, await service.registerObject(await readBody(req)));
      }
      if (req.method === 'GET' && p === '/api/objects') {
        const state = service.getSnapshot(q.get('atLineageVersion'));
        return ok(res, [...state.objects.values()]);
      }

      // ---------- 字段 ----------
      if (req.method === 'POST' && p === '/api/fields') {
        return created(res, await service.registerField(await readBody(req)));
      }
      if (req.method === 'GET' && p === '/api/fields') {
        const state = service.getSnapshot(q.get('atLineageVersion'));
        return ok(
          res,
          [...state.fields.values()].map((f) => ({
            ...f,
            fieldName: f.name,
            objectName: state.objects.get(f.objectId)?.name,
            objectType: state.objects.get(f.objectId)?.type,
          })),
        );
      }
      const fieldMatch = p.match(/^\/api\/fields\/([^/]+)$/);
      if (req.method === 'GET' && fieldMatch) {
        const f = service.getField(fieldMatch[1]);
        return ok(res, { ...f, fieldName: f.name });
      }
      const renameMatch = p.match(/^\/api\/fields\/([^/]+)\/rename$/);
      if (req.method === 'POST' && renameMatch) {
        const body = await readBody(req);
        return ok(res, await service.renameField(renameMatch[1], body.newName, body.reason ?? ''));
      }
      const deleteMatch = p.match(/^\/api\/fields\/([^/]+)\/delete$/);
      if (req.method === 'POST' && deleteMatch) {
        const body = await readBody(req);
        return ok(res, await service.deleteField(deleteMatch[1], body.reason ?? ''));
      }

      // ---------- 血缘登记 ----------
      if (req.method === 'POST' && p === '/api/lineage/batches') {
        const body = await readBody(req);
        return created(res, await service.registerLineageBatch(body.entries ?? body));
      }
      if (req.method === 'GET' && p === '/api/lineage/batches') {
        const state = service.getCurrentState();
        return ok(res, state.batches);
      }

      // ---------- 血缘图 / 快照 ----------
      if (req.method === 'GET' && p === '/api/lineage/graph') {
        if (q.get('fieldId')) return ok(res, service.focusGraph(q.get('fieldId')));
        const state = service.getSnapshot(q.get('atLineageVersion'));
        return ok(res, service.decorateState(state));
      }

      // ---------- 版本差异 ----------
      if (req.method === 'GET' && p === '/api/versions/diff') {
        const from = q.get('fromVersion') == null ? undefined : Number(q.get('fromVersion'));
        const to = q.get('toVersion') == null ? undefined : Number(q.get('toVersion'));
        return ok(res, service.diffVersions(from, to));
      }

      // ---------- 影响分析 ----------
      if (req.method === 'GET' && p === '/api/impacts') {
        return ok(res, service.getCurrentState().impacts);
      }
      const impactMatch = p.match(/^\/api\/impacts\/([^/]+)$/);
      if (req.method === 'GET' && impactMatch) {
        return ok(res, service.getImpact(impactMatch[1]));
      }

      // ---------- 迁移 ----------
      const migrationMatch = p.match(/^\/api\/migrations\/([^/]+)\/status$/);
      if (req.method === 'POST' && migrationMatch) {
        const body = await readBody(req);
        return ok(res, await service.updateMigration(migrationMatch[1], body.status, body.reason ?? ''));
      }
      const remapMatch = p.match(/^\/api\/migrations\/([^/]+)\/remap$/);
      if (req.method === 'POST' && remapMatch) {
        const body = await readBody(req);
        return ok(
          res,
          await service.remapMigration(remapMatch[1], body.alternativeFieldId, body.reason ?? ''),
        );
      }

      // ---------- 健康检查 ----------
      if (req.method === 'GET' && p === '/api/health') {
        const state = service.getCurrentState();
        return ok(res, {
          lineageVersion: state.lineageVersion,
          objectCount: state.objects.size,
          fieldCount: state.fields.size,
          edgeCount: state.edges.length,
          impactCount: state.impacts.length,
        });
      }

      return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${p}` } });
    } catch (err) {
      return fail(res, err);
    }
  };
}
