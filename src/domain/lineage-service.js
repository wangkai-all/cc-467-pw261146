import { foldAll, foldAtLineageVersion, FIELD_STATUS } from './reducer.js';
import {
  buildFieldGraph,
  buildResolverIndexes,
  detectCycle,
  downstreamClosure,
  upstreamClosure,
} from './graph.js';
import { resolveExpression, tokenizeExpression } from './expression.js';
import { ValidationError, conflict, notFound } from './errors.js';
import { newId } from './ids.js';

export const MIGRATION_STATUS = Object.freeze({
  BLOCKED: 'blocked',
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  WONT_MIGRATE: 'wont_migrate',
});

/**
 * 血缘领域服务。所有写操作：折叠当前状态 -> 校验 -> 追加事件。
 * 读操作可折叠到历史血缘版本，历史结果不受后续事件影响。
 */
export class LineageService {
  constructor(store) {
    this.store = store;
    this._events = [];
    this._state = null;
  }

  async init() {
    this._events = await this.store.init();
    this._state = foldAll(this._events);
  }

  /** 每次写操作前刷新（事件已通过 append 串行化） */
  _refresh() {
    this._state = foldAll(this._events);
    return this._state;
  }

  async _append(type, payload) {
    const event = await this.store.append(type, payload);
    this._events.push(event);
    this._refresh();
    return event;
  }

  // ---------- 查询 ----------

  getCurrentState() {
    return this._refresh();
  }

  getSnapshot(atLineageVersion) {
    if (atLineageVersion == null) return this.getCurrentState();
    const v = Number(atLineageVersion);
    if (!Number.isInteger(v) || v < 0) throw new ValidationError('atLineageVersion 必须是非负整数');
    if (v > this._state.lineageVersion) {
      throw notFound(`血缘版本 ${v} 不存在，当前最大版本为 ${this._state.lineageVersion}`);
    }
    return foldAtLineageVersion(this._events, v);
  }

  getObject(objectId) {
    const obj = this._state.objects.get(objectId);
    if (!obj) throw notFound(`对象不存在: ${objectId}`);
    return obj;
  }

  getField(fieldId) {
    const field = this._state.fields.get(fieldId);
    if (!field) throw notFound(`字段不存在: ${fieldId}`);
    return field;
  }

  getImpact(impactId) {
    const impact = this._state.impacts.find((i) => i.impactId === impactId);
    if (!impact) throw notFound(`影响分析不存在: ${impactId}`);
    return impact;
  }

  // ---------- 对象 / 字段注册 ----------

  async registerObject({ type, name, description }) {
    this._refresh();
    if (!['source', 'model', 'report'].includes(type)) {
      throw new ValidationError("对象类型必须是 source | model | report");
    }
    if (!name || !String(name).trim()) throw new ValidationError('对象名称不能为空');
    for (const obj of this._state.objects.values()) {
      if (obj.name === name) throw conflict(`对象名称已存在: ${name}`);
    }
    const payload = {
      objectId: newId('obj'),
      type,
      name: String(name).trim(),
      description: description ?? '',
      objectVersion: 1,
    };
    await this._append('OBJECT_REGISTERED', payload);
    return payload;
  }

  async registerField({ objectId, fieldName, dataType, description }) {
    this._refresh();
    const obj = this._state.objects.get(objectId);
    if (!obj) throw notFound(`对象不存在: ${objectId}`);
    if (!fieldName || !String(fieldName).trim()) throw new ValidationError('字段名称不能为空');
    this._assertFieldNameFree(objectId, fieldName);
    const payload = {
      fieldId: newId('fld'),
      objectId,
      fieldName: String(fieldName).trim(),
      dataType: dataType ?? 'string',
      description: description ?? '',
      fieldVersion: 1,
    };
    await this._append('FIELD_REGISTERED', payload);
    return payload;
  }

  _assertFieldNameFree(objectId, fieldName, exceptFieldId = null) {
    for (const f of this._state.fields.values()) {
      if (f.objectId !== objectId) continue;
      if (f.name === fieldName && f.fieldId !== exceptFieldId && f.status === FIELD_STATUS.ACTIVE) {
        throw conflict(`对象 ${objectId} 下字段名已存在: ${fieldName}`);
      }
    }
  }

  // ---------- 血缘批次注册（部分失败 + 循环引用） ----------

  /**
   * @param {{targetObjectId?:string, targetFieldId?:string, targetFieldName?:string,
   *          sourceObjectId?:string, sourceFieldId?:string, sourceFieldName?:string,
   *          transformExpression?:string}}[] entries
   */
  async registerLineageBatch(entries) {
    const state = this._refresh();
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new ValidationError('批次至少包含一条血缘登记');
    }

    const { fieldByQualifiedName, fieldBySimpleName } = buildResolverIndexes(state);
    const findField = (entry, role) => {
      // 入口同时接受 fieldId 与 <role>FieldId 两种命名
      const fieldId = entry.fieldId ?? entry[`${role === '目标' ? 'target' : 'source'}FieldId`];
      const objectId = entry.objectId ?? entry[`${role === '目标' ? 'target' : 'source'}ObjectId`];
      const fieldName = entry.fieldName ?? entry[`${role === '目标' ? 'target' : 'source'}FieldName`];
      // 1) fieldId 直接定位
      if (fieldId) {
        const f = state.fields.get(fieldId);
        if (!f) return { error: `${role}字段不存在: ${fieldId}` };
        if (f.status !== FIELD_STATUS.ACTIVE) return { error: `${role}字段已删除: ${fieldId}` };
        return { field: f };
      }
      // 2) objectId + fieldName
      if (objectId && fieldName) {
        const f = [...state.fields.values()].find(
          (x) => x.objectId === objectId && x.name === fieldName && x.status === FIELD_STATUS.ACTIVE,
        );
        if (!f) return { error: `${role}字段不存在: ${objectId}.${fieldName}` };
        return { field: f };
      }
      // 3) 仅 fieldName：先全限定名（object.field），再裸名
      if (fieldName) {
        const qualified = fieldByQualifiedName.get(fieldName);
        const ref = qualified ?? fieldBySimpleName.get(fieldName);
        if (!ref) return { error: `${role}字段无法解析: ${fieldName}` };
        const f = [...state.fields.values()].find(
          (x) => x.objectId === ref.objectId && x.name === ref.fieldName && x.status === FIELD_STATUS.ACTIVE,
        );
        if (!f) return { error: `${role}字段无法解析: ${fieldName}` };
        return { field: f };
      }
      return { error: `${role}字段定位信息缺失（fieldId 或 objectId+fieldName）` };
    };

    // 第一阶段：逐条解析与校验，结果互不影响 -> 支持部分失败
    const resolved = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const targetPart = {
        fieldId: entry.targetFieldId ?? entry.fieldId,
        objectId: entry.targetObjectId,
        fieldName: entry.targetFieldName,
      };
      const sourcePart = {
        fieldId: entry.sourceFieldId,
        objectId: entry.sourceObjectId,
        fieldName: entry.sourceFieldName,
      };
      const target = findField(targetPart, '目标');
      if (target.error) {
        resolved.push({ index, status: 'failed', reason: target.error });
        continue;
      }
      const source = findField(sourcePart, '来源');
      if (source.error) {
        resolved.push({ index, status: 'failed', reason: source.error });
        continue;
      }
      const expr = entry.transformExpression ?? '';
      const { refs, unresolved } = resolveExpression(expr, fieldByQualifiedName, fieldBySimpleName);
      if (unresolved.length) {
        resolved.push({
          index,
          status: 'failed',
          reason: `转换表达式存在无法解析的标识符: ${unresolved.join(', ')}`,
        });
        continue;
      }
      // 显式来源必须与表达式中解析出的引用一致（若表达式非空）
      if (expr.trim()) {
        const refFieldIds = refs.map((r) =>
          [...state.fields.values()].find((f) => f.objectId === r.objectId && f.name === r.fieldName)?.fieldId,
        );
        if (!refFieldIds.includes(source.field.fieldId)) {
          resolved.push({
            index,
            status: 'failed',
            reason: `表达式未引用声明的来源字段 ${source.field.name}`,
          });
          continue;
        }
      }
      // 同对象内自引用无意义
      if (source.field.fieldId === target.field.fieldId) {
        resolved.push({ index, status: 'failed', reason: '来源字段与目标字段相同，禁止自引用' });
        continue;
      }
      // 与已注册边重复
      const dup = state.edges.find(
        (e) => e.sourceFieldId === source.field.fieldId && e.targetFieldId === target.field.fieldId,
      );
      if (dup) {
        resolved.push({
          index,
          status: 'skipped',
          reason: `血缘已存在（批次 ${dup.batchId}），跳过重复登记`,
          edgeId: dup.edgeId,
        });
        continue;
      }
      resolved.push({
        index,
        status: 'ok',
        sourceField: source.field,
        targetField: target.field,
        transformExpression: expr,
        expressionRefs: refs.map((r) => ({ objectId: r.objectId, fieldName: r.fieldName })),
      });
    }

    const okEntries = resolved.filter((r) => r.status === 'ok');
    // 批次内重复边检测（同样的 source->target 出现多次）
    const intraSeen = new Map();
    for (const r of okEntries) {
      const key = `${r.sourceField.fieldId}->${r.targetField.fieldId}`;
      if (intraSeen.has(key)) {
        r.status = 'skipped';
        r.reason = `与批次内第 ${intraSeen.get(key) + 1} 条重复，跳过`;
      } else {
        intraSeen.set(key, r.index);
      }
    }

    const candidates = okEntries
      .filter((r) => r.status === 'ok')
      .map((r) => ({ sourceFieldId: r.sourceField.fieldId, targetFieldId: r.targetField.fieldId, index: r.index }));

    // 第二阶段：循环引用检测（存量边 + 本批候选边一起做 DFS）
    if (candidates.length) {
      const graph = buildFieldGraph(state);
      const cyc = detectCycle(graph, candidates);
      if (cyc) {
        const victim = resolved[cyc.edge.index];
        victim.status = 'failed';
        victim.reason = `检测到循环引用: ${cyc.cycle.map((id) => this._label(state, id)).join(' -> ')}`;
        candidates.splice(
          candidates.findIndex((c) => c.index === cyc.edge.index),
          1,
        );
        // 去掉一条候选边后再检测，确保其余边本身无环（环可能由多条候选边共同构成）
        let guard = candidates.length;
        while (guard-- > 0) {
          const again = detectCycle(graph, candidates);
          if (!again) break;
          const v = resolved[again.edge.index];
          v.status = 'failed';
          v.reason = `检测到循环引用: ${again.cycle.map((id) => this._label(state, id)).join(' -> ')}`;
          candidates.splice(
            candidates.findIndex((c) => c.index === again.edge.index),
            1,
          );
        }
      }
    }

    const committed = resolved
      .filter((r) => r.status === 'ok' && candidates.some((c) => c.index === r.index))
      .map((r) => ({
        edgeId: newId('edge'),
        sourceFieldId: r.sourceField.fieldId,
        targetFieldId: r.targetField.fieldId,
        sourceFieldVersion: r.sourceField.fieldVersion,
        targetFieldVersion: r.targetField.fieldVersion,
        sourceObjectId: r.sourceField.objectId,
        targetObjectId: r.targetField.objectId,
        transformExpression: r.transformExpression,
        expressionRefs: r.expressionRefs,
      }));

    let batchId = null;
    let lineageVersion = state.lineageVersion;
    if (committed.length) {
      batchId = newId('batch');
      lineageVersion = state.lineageVersion + 1;
      await this._append('LINEAGE_REGISTERED', {
        batchId,
        lineageVersion,
        entries: committed,
      });
    }

    return {
      batchId,
      lineageVersion,
      total: entries.length,
      committedCount: committed.length,
      failedCount: resolved.filter((r) => r.status === 'failed').length,
      skippedCount: resolved.filter((r) => r.status === 'skipped').length,
      results: resolved.map((r) => ({
        index: r.index,
        status: r.status,
        reason: r.reason ?? null,
        edgeId: r.edgeId ?? committed.find((c) => {
          const rr = resolved[r.index];
          return rr && c.sourceFieldId === rr.sourceField?.fieldId && c.targetFieldId === rr.targetField?.fieldId;
        })?.edgeId ?? null,
      })),
    };
  }

  // ---------- 改名 / 删除与影响分析 ----------

  async renameField(fieldId, newName, reason = '') {
    const state = this._refresh();
    const field = state.fields.get(fieldId);
    if (!field) throw notFound(`字段不存在: ${fieldId}`);
    if (field.status !== FIELD_STATUS.ACTIVE) throw conflict(`字段已删除，无法改名: ${fieldId}`);
    if (!newName || !String(newName).trim()) throw new ValidationError('新字段名不能为空');
    this._assertFieldNameFree(field.objectId, newName, fieldId);
    const fromName = field.name;
    const payload = {
      fieldId,
      fromName,
      toName: String(newName).trim(),
      fieldVersion: field.fieldVersion + 1,
      reason,
    };
    await this._append('FIELD_RENAMED', payload);
    const impact = await this._analyzeImpact({
      changeType: 'rename',
      fieldId,
      fromName,
      toName: payload.toName,
      fieldVersion: payload.fieldVersion,
      reason,
    });
    return { rename: payload, impact };
  }

  async deleteField(fieldId, reason = '') {
    const state = this._refresh();
    const field = state.fields.get(fieldId);
    if (!field) throw notFound(`字段不存在: ${fieldId}`);
    if (field.status !== FIELD_STATUS.ACTIVE) throw conflict(`字段已删除: ${fieldId}`);
    const payload = {
      fieldId,
      fieldName: field.name,
      fieldVersion: field.fieldVersion + 1,
      reason,
    };
    await this._append('FIELD_DELETED', payload);
    const impact = await this._analyzeImpact({
      changeType: 'delete',
      fieldId,
      fromName: field.name,
      toName: null,
      fieldVersion: payload.fieldVersion,
      reason,
    });
    return { delete: payload, impact };
  }

  /**
   * 影响分析核心：
   *  1) 下游闭包得到全部受影响字段与对象；
   *  2) 为每条直接消费该字段的血缘边生成迁移单（替代字段 + 阻断原因）；
   *  3) 事件落盘，迁移状态可跟踪。
   */
  async _analyzeImpact({ changeType, fieldId, fromName, toName, fieldVersion, reason }) {
    const state = this._refresh();
    const field = state.fields.get(fieldId);
    const object = state.objects.get(field.objectId);
    const closure = downstreamClosure(state, [fieldId]);
    const directEdges = state.edges.filter((e) => e.sourceFieldId === fieldId && !e.inactive);

    // 替代字段候选：同对象内同数据类型、仍存活的字段；改名时优先使用新名字
    const alternatives = this._findAlternatives(state, field, toName);

    const affectedFieldIds = [...closure.keys()].filter((id) => id !== fieldId);
    const affectedObjects = [];
    const objSeen = new Set();
    for (const id of affectedFieldIds) {
      const f = state.fields.get(id);
      if (!objSeen.has(f.objectId)) {
        objSeen.add(f.objectId);
        const o = state.objects.get(f.objectId);
        affectedObjects.push({
          objectId: o.objectId,
          objectName: o.name,
          objectType: o.type,
          affectedFieldCount: affectedFieldIds.filter((fid) => state.fields.get(fid)?.objectId === o.objectId).length,
        });
      }
    }

    const migrations = directEdges.map((edge) => {
      const target = state.fields.get(edge.targetFieldId);
      const targetObj = state.objects.get(target.objectId);
      const blockingReasons = [];
      let chosen = null;
      if (changeType === 'rename') {
        chosen = alternatives.find((a) => a.name === toName) ?? alternatives[0] ?? null;
        if (!chosen) blockingReasons.push('改名后不存在可自动替换的同名字段，需要人工确认表达式改写');
      } else {
        chosen = alternatives[0] ?? null;
        if (!chosen) blockingReasons.push('同对象内没有兼容数据类型的存活字段可作为替代');
        if (tokenizeExpression(edge.transformExpression).identifiers.length > 1) {
          blockingReasons.push('转换表达式引用了多个字段，删除后语义无法由单一替代字段保持');
        }
      }
      let status = blockingReasons.length ? MIGRATION_STATUS.BLOCKED : MIGRATION_STATUS.PENDING;
      if (changeType === 'rename') {
        // 改名：只有存在与新名称一致的存活字段可无缝替换时才不阻断
        const exact = alternatives.find((a) => a.name === toName);
        if (!exact) {
          status = MIGRATION_STATUS.BLOCKED;
          if (!blockingReasons.length) {
            blockingReasons.push('改名后不存在同名字段，下游表达式需要人工改写');
          }
        }
      }
      return {
        edgeId: edge.edgeId,
        targetFieldId: target.fieldId,
        targetObjectName: targetObj.name,
        targetFieldName: target.name,
        targetObjectType: targetObj.type,
        transformExpression: edge.transformExpression,
        pinnedSourceFieldVersion: edge.sourceFieldVersion,
        status,
        blockingReasons,
        alternatives: alternatives.map((a) => ({
          fieldId: a.fieldId,
          name: a.name,
          dataType: a.dataType,
          score: a.score,
          matchReason: a.matchReason,
        })),
        altSourceFieldId: chosen?.fieldId ?? null,
        remapped: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        history: [
          {
            fromStatus: null,
            toStatus: status,
            reason: blockingReasons.join('；') || '已匹配替代字段，待迁移',
            at: new Date().toISOString(),
          },
        ],
      };
    });

    const progress = computeProgress(migrations);
    const impact = {
      impactId: newId('impact'),
      changeType,
      fieldId,
      objectId: field.objectId,
      objectName: object.name,
      fromName,
      toName,
      fieldVersion,
      reason,
      atLineageVersion: state.lineageVersion,
      affectedFieldCount: affectedFieldIds.length,
      affectedFields: affectedFieldIds.map((id) => {
        const f = state.fields.get(id);
        const o = state.objects.get(f.objectId);
        return {
          fieldId: id,
          fieldName: f.name,
          objectId: f.objectId,
          objectName: o.name,
          objectType: o.type,
          distance: closure.get(id).distance,
          path: closure.get(id).path.map((pid) => this._label(state, pid)),
          status: f.status,
        };
      }),
      affectedObjects,
      migrations,
      progress,
      createdAt: new Date().toISOString(),
    };
    await this._append('IMPACT_ANALYZED', impact);
    return impact;
  }

  _findAlternatives(state, field, preferredName = null) {
    const sameObject = [...state.fields.values()].filter(
      (f) => f.objectId === field.objectId && f.fieldId !== field.fieldId && f.status === FIELD_STATUS.ACTIVE,
    );
    const scored = sameObject.map((f) => {
      let score = 0;
      const matchReason = [];
      if (f.dataType === field.dataType) {
        score += 50;
        matchReason.push(`数据类型一致(${f.dataType})`);
      }
      if (preferredName && f.name === preferredName) {
        score += 40;
        matchReason.push('名称与改名后一致');
      }
      const lf = f.name.toLowerCase();
      const base = (preferredName ?? field.name).toLowerCase();
      if (lf.includes(base) || base.includes(lf)) {
        score += 20;
        matchReason.push('名称相似');
      }
      return { fieldId: f.fieldId, name: f.name, dataType: f.dataType, score, matchReason: matchReason.join('；') };
    });
    return scored.sort((a, b) => b.score - a.score);
  }

  // ---------- 迁移操作 ----------

  async updateMigration(edgeId, toStatus, reason = '') {
    const state = this._refresh();
    const holder = state.migrationIndex.get(edgeId);
    if (!holder) throw notFound(`迁移单不存在: ${edgeId}`);
    const from = holder.migration.status;
    const allowed = {
      [MIGRATION_STATUS.BLOCKED]: [MIGRATION_STATUS.PENDING, MIGRATION_STATUS.WONT_MIGRATE],
      [MIGRATION_STATUS.PENDING]: [MIGRATION_STATUS.IN_PROGRESS, MIGRATION_STATUS.DONE, MIGRATION_STATUS.WONT_MIGRATE],
      [MIGRATION_STATUS.IN_PROGRESS]: [MIGRATION_STATUS.DONE, MIGRATION_STATUS.WONT_MIGRATE, MIGRATION_STATUS.PENDING],
      [MIGRATION_STATUS.DONE]: [MIGRATION_STATUS.IN_PROGRESS],
      [MIGRATION_STATUS.WONT_MIGRATE]: [MIGRATION_STATUS.PENDING],
    };
    if (!allowed[from]?.includes(toStatus)) {
      throw conflict(`迁移单不能从 ${from} 切换到 ${toStatus}`);
    }
    if (from === MIGRATION_STATUS.BLOCKED && toStatus === MIGRATION_STATUS.PENDING && !reason) {
      throw new ValidationError('解除阻断必须填写处理说明');
    }
    await this._append('MIGRATION_STATUS_CHANGED', { edgeId, fromStatus: from, toStatus, reason });
    return this._state.migrationIndex.get(edgeId).migration;
  }

  async remapMigration(edgeId, alternativeFieldId, reason = '') {
    const state = this._refresh();
    const holder = state.migrationIndex.get(edgeId);
    if (!holder) throw notFound(`迁移单不存在: ${edgeId}`);
    const alt = state.fields.get(alternativeFieldId);
    if (!alt) throw notFound(`替代字段不存在: ${alternativeFieldId}`);
    if (alt.status !== FIELD_STATUS.ACTIVE) throw conflict('替代字段已删除，无法改引');
    await this._append('MIGRATION_REMAPPED', {
      edgeId,
      alternativeFieldId,
      reason,
    });
    // 若仍处于阻断态，提供说明后自动解除为待处理
    const now = this._state.migrationIndex.get(edgeId).migration;
    if (now.status === MIGRATION_STATUS.BLOCKED) {
      await this._append('MIGRATION_STATUS_CHANGED', {
        edgeId,
        fromStatus: MIGRATION_STATUS.BLOCKED,
        toStatus: MIGRATION_STATUS.PENDING,
        reason: reason || '已选择替代字段，解除阻断',
      });
    }
    return this._state.migrationIndex.get(edgeId).migration;
  }

  // ---------- 版本差异 ----------

  /**
   * 对比两个血缘版本（默认上一版本 -> 当前版本）。
   * 历史快照不可变，差异来自两个独立折叠结果。
   */
  diffVersions(fromVersion, toVersion) {
    const current = this._state.lineageVersion;
    const to = toVersion ?? current;
    const from = fromVersion ?? Math.max(0, to - 1);
    if (from > to) throw new ValidationError('fromVersion 不能大于 toVersion');
    const sFrom = this.getSnapshot(from);
    const sTo = this.getSnapshot(to);

    const oldEdges = new Map(sFrom.edges.map((e) => [e.edgeId, e]));
    const newEdges = new Map(sTo.edges.map((e) => [e.edgeId, e]));
    const added = [...newEdges.values()].filter((e) => !oldEdges.has(e.edgeId));
    const removed = [...oldEdges.values()].filter((e) => !newEdges.has(e.edgeId));

    // 字段变化：取两个血缘版本对应事件序号窗口内的 FIELD_* 事件。
    // 用事件而非快照对比，避免字段在 from 快照中尚不存在时漏报。
    // 窗口：(from 版本批次序号, to 版本批次序号]；to 为当前最新版本时延伸到事件流末尾，
    // 使最新版本之后发生的改名/删除仍可被差异视图展示。
    const seqFrom = from === 0 ? 0 : (sFrom.batches.at(-1)?.seq ?? 0);
    const seqTo = to === current ? Number.POSITIVE_INFINITY : (sTo.batches.at(-1)?.seq ?? 0);
    const fieldChanges = [];
    for (const ev of this._events) {
      if (ev.seq <= seqFrom || ev.seq > seqTo) continue;
      if (!['FIELD_REGISTERED', 'FIELD_RENAMED', 'FIELD_DELETED'].includes(ev.type)) continue;
      const p = ev.payload;
      const field = this._state.fields.get(p.fieldId);
      const obj = field && this._state.objects.get(field.objectId);
      if (ev.type === 'FIELD_REGISTERED') {
        fieldChanges.push({
          fieldId: p.fieldId,
          objectName: this._state.objects.get(p.objectId)?.name,
          fieldName: p.fieldName,
          change: 'created',
          fromVersion: null,
          toVersion: p.fieldVersion,
        });
      } else if (ev.type === 'FIELD_RENAMED') {
        fieldChanges.push({
          fieldId: p.fieldId,
          objectName: obj?.name,
          fieldName: p.toName,
          change: 'renamed',
          fromName: p.fromName,
          toName: p.toName,
          fromVersion: p.fieldVersion - 1,
          toVersion: p.fieldVersion,
        });
      } else {
        fieldChanges.push({
          fieldId: p.fieldId,
          objectName: obj?.name,
          fieldName: p.fieldName,
          change: 'deleted',
          fromName: p.fieldName,
          toName: null,
          fromVersion: p.fieldVersion - 1,
          toVersion: p.fieldVersion,
        });
      }
    }

    return {
      fromVersion: from,
      toVersion: to,
      edgeAdded: added.map((e) => this._decorateEdge(sTo, e)),
      edgeRemoved: removed.map((e) => this._decorateEdge(sFrom, e)),
      fieldChanges,
      batchesInRange: sTo.batches.filter((b) => b.lineageVersion > from && b.lineageVersion <= to),
    };
  }

  // ---------- 视图装饰 ----------

  /** 给边/字段图补上人类可读标签与钉选版本信息 */
  decorateState(state) {
    const objects = [...state.objects.values()];
    const fields = [...state.fields.values()].map((f) => {
      const obj = state.objects.get(f.objectId);
      return {
        ...f,
        objectName: obj?.name,
        objectType: obj?.type,
      };
    });
    const edges = state.edges.map((e) => this._decorateEdge(state, e));
    return {
      lineageVersion: state.lineageVersion,
      snapshotAt: state.snapshotAt ?? null,
      objects,
      fields,
      edges,
      batches: state.batches,
      impacts: state.impacts,
    };
  }

  /** 血缘图页面：聚焦某个字段，返回其上游+下游子图 */
  focusGraph(fieldId, depth = 3) {
    const state = this.getCurrentState();
    if (!state.fields.has(fieldId)) throw notFound(`字段不存在: ${fieldId}`);
    const up = upstreamClosure(state, [fieldId]);
    const down = downstreamClosure(state, [fieldId]);
    const keep = new Set([...up.keys(), ...down.keys()]);
    const edges = state.edges.filter(
      (e) => keep.has(e.sourceFieldId) && keep.has(e.targetFieldId),
    );
    return {
      centerFieldId: fieldId,
      depth,
      nodes: [...keep].map((id) => {
        const f = state.fields.get(id);
        const o = state.objects.get(f.objectId);
        return {
          fieldId: id,
          fieldName: f.name,
          fieldVersion: f.fieldVersion,
          status: f.status,
          objectId: f.objectId,
          objectName: o.name,
          objectType: o.type,
          upstreamDistance: up.get(id)?.distance ?? null,
          downstreamDistance: down.get(id)?.distance ?? null,
        };
      }),
      edges: edges.map((e) => this._decorateEdge(state, e)),
    };
  }

  fullGraph() {
    const state = this.getCurrentState();
    return this.decorateState(state);
  }

  _decorateEdge(state, edge) {
    const src = state.fields.get(edge.sourceFieldId);
    const tgt = state.fields.get(edge.targetFieldId);
    const srcObj = src && state.objects.get(src.objectId);
    const tgtObj = tgt && state.objects.get(tgt.objectId);
    const migration = state.migrationIndex?.get(edge.edgeId)?.migration;
    return {
      ...edge,
      sourceFieldName: src?.name,
      sourceObjectName: srcObj?.name,
      sourceObjectType: srcObj?.type,
      targetFieldName: tgt?.name,
      targetObjectName: tgtObj?.name,
      targetObjectType: tgtObj?.type,
      sourceStatus: src?.status,
      targetStatus: tgt?.status,
      // 版本是否漂移：注册时钉选的版本与当前版本不同
      sourceVersionDrift: src ? edge.sourceFieldVersion !== src.fieldVersion : null,
      targetVersionDrift: tgt ? edge.targetFieldVersion !== tgt.fieldVersion : null,
      migrationStatus: migration?.status ?? null,
    };
  }

  _label(state, fieldId) {
    const f = state.fields.get(fieldId);
    if (!f) return fieldId;
    const o = state.objects.get(f.objectId);
    return `${o?.name ?? f.objectId}.${f.name}@v${f.fieldVersion}`;
  }
}

export function computeProgress(migrations) {
  const total = migrations.length;
  const counts = { blocked: 0, pending: 0, in_progress: 0, done: 0, wont_migrate: 0 };
  for (const m of migrations) counts[m.status] = (counts[m.status] ?? 0) + 1;
  const finished = counts.done + counts.wont_migrate;
  return {
    total,
    ...counts,
    finished,
    completionRate: total ? Number((finished / total).toFixed(4)) : 1,
  };
}
