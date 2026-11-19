/**
 * 事件折叠器（reducer）：把仅追加的事件流还原为状态。
 *
 * 关键不变量：
 *  - 事件永不修改/删除，任何历史时点的血缘都可重新折叠；
 *  - 字段每次改名/删除都会产生新的 fieldVersion，旧名称进入 nameHistory；
 *  - 血缘边一旦注册即不可变，并钉住当时两端的字段版本；
 *  - 快照按 lineageVersion 过滤血缘批次，新注册的血缘不会出现在旧快照里。
 */

export const FIELD_STATUS = Object.freeze({
  ACTIVE: 'active',
  DELETED: 'deleted',
});

export function emptyState() {
  return {
    objects: new Map(), // objectId -> object
    fields: new Map(), // fieldId -> field
    edges: [], // 全部已注册血缘边（不可变，按批次追加）
    batches: [], // 血缘批次摘要
    lineageVersion: 0,
    impacts: [], // 影响分析记录（新的在前）
    migrationIndex: new Map(), // edgeId -> { impactId, migration }
    seq: 0,
  };
}

export function foldAll(events) {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/**
 * 折叠到指定血缘版本：对象/字段事件照常折叠（保留字段完整版本史与删除标记），
 * 血缘边只包含 lineageVersion <= atLineageVersion 的批次。
 * 这样查询历史血缘时，后续注册的边绝不会覆盖结果。
 */
export function foldAtLineageVersion(events, atLineageVersion) {
  const state = emptyState();
  for (const event of events) {
    if (event.type === 'LINEAGE_REGISTERED' && event.payload.lineageVersion > atLineageVersion) {
      continue;
    }
    applyEvent(state, event);
  }
  state.lineageVersion = atLineageVersion;
  state.snapshotAt = atLineageVersion;
  return state;
}

function applyEvent(state, event) {
  state.seq = event.seq;
  const { type, payload, at } = event;
  switch (type) {
    case 'OBJECT_REGISTERED': {
      state.objects.set(payload.objectId, {
        objectId: payload.objectId,
        type: payload.type,
        name: payload.name,
        description: payload.description ?? '',
        objectVersion: payload.objectVersion,
        createdAt: at,
      });
      break;
    }
    case 'FIELD_REGISTERED': {
      state.fields.set(payload.fieldId, {
        fieldId: payload.fieldId,
        objectId: payload.objectId,
        name: payload.fieldName,
        dataType: payload.dataType,
        description: payload.description ?? '',
        fieldVersion: payload.fieldVersion,
        status: FIELD_STATUS.ACTIVE,
        nameHistory: [],
        createdAt: at,
      });
      break;
    }
    case 'FIELD_RENAMED': {
      const field = state.fields.get(payload.fieldId);
      if (!field) throw new Error(`事件 ${event.seq}: 未知字段 ${payload.fieldId}`);
      field.nameHistory.push({
        fromName: payload.fromName,
        toName: payload.toName,
        fieldVersion: payload.fieldVersion,
        at,
      });
      field.name = payload.toName;
      field.fieldVersion = payload.fieldVersion;
      break;
    }
    case 'FIELD_DELETED': {
      const field = state.fields.get(payload.fieldId);
      if (!field) throw new Error(`事件 ${event.seq}: 未知字段 ${payload.fieldId}`);
      field.status = FIELD_STATUS.DELETED;
      field.fieldVersion = payload.fieldVersion;
      field.deletedAt = at;
      break;
    }
    case 'LINEAGE_REGISTERED': {
      state.lineageVersion = payload.lineageVersion;
      state.batches.push({
        batchId: payload.batchId,
        lineageVersion: payload.lineageVersion,
        edgeCount: payload.entries.length,
        seq: event.seq,
        at,
      });
      for (const e of payload.entries) {
        state.edges.push({
          ...e,
          batchId: payload.batchId,
          registeredAt: at,
        });
      }
      break;
    }
    case 'IMPACT_ANALYZED': {
      state.impacts.unshift(payload);
      for (const migration of payload.migrations ?? []) {
        state.migrationIndex.set(migration.edgeId, { impactId: payload.impactId, migration });
      }
      break;
    }
    case 'MIGRATION_STATUS_CHANGED': {
      const holder = state.migrationIndex.get(payload.edgeId);
      if (!holder) throw new Error(`事件 ${event.seq}: 未知迁移单 ${payload.edgeId}`);
      const migration = holder.migration;
      migration.status = payload.toStatus;
      if (payload.reason !== undefined) migration.reason = payload.reason;
      migration.updatedAt = at;
      migration.history.push({
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        reason: payload.reason ?? null,
        at,
      });
      break;
    }
    case 'MIGRATION_REMAPPED': {
      const holder = state.migrationIndex.get(payload.edgeId);
      if (!holder) throw new Error(`事件 ${event.seq}: 未知迁移单 ${payload.edgeId}`);
      const migration = holder.migration;
      migration.altSourceFieldId = payload.alternativeFieldId;
      migration.remapped = true;
      migration.updatedAt = at;
      migration.history.push({
        fromStatus: migration.status,
        toStatus: migration.status,
        reason: `改引替代字段 ${payload.alternativeFieldId}`,
        at,
      });
      break;
    }
    default:
      throw new Error(`未知事件类型: ${type}`);
  }
}
