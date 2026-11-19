/**
 * 字段级血缘图的查询算子：
 *  - 名称索引（全限定名 / 裸字段名）
 *  - 循环引用检测（DFS 三色标记，同时检测批次内新建边）
 *  - 下游闭包（改名/删除时的受影响对象）
 */

/** 给表达式解析器使用的索引（仅存活字段，key 与解析器约定一致） */
export function buildResolverIndexes(state) {
  const fieldByQualifiedName = new Map();
  const fieldBySimpleName = new Map();
  for (const field of state.fields.values()) {
    if (field.status !== 'active') continue;
    const obj = state.objects.get(field.objectId);
    if (!obj) continue;
    // 值结构与 expression.resolveExpression 的约定一致：{ objectId, fieldName }
    const ref = { objectId: obj.objectId, fieldName: field.name };
    fieldByQualifiedName.set(`${obj.name}.${field.name}`, ref);
    const existing = fieldBySimpleName.get(field.name);
    if (!existing) fieldBySimpleName.set(field.name, ref); // 裸名冲突时保留首个，要求全限定
  }
  return { fieldByQualifiedName, fieldBySimpleName };
}

/**
 * 构建字段级有向图：sourceFieldId -> targetFieldId[]
 * inactive=true 的边（端点已删除）仍保留以支持历史查询，但默认不参与环检测。
 */
export function buildFieldGraph(state, { includeInactive = false } = {}) {
  const graph = new Map();
  const ensure = (id) => {
    let set = graph.get(id);
    if (!set) {
      set = new Set();
      graph.set(id, set);
    }
    return set;
  };
  for (const edge of state.edges) {
    if (!includeInactive && edge.inactive) continue;
    ensure(edge.sourceFieldId).add(edge.targetFieldId);
    ensure(edge.targetFieldId);
  }
  return graph;
}

/**
 * 循环引用检测。
 * @param graph 现有图
 * @param candidateEdges 批次内待加入的边 [{sourceFieldId, targetFieldId, index}]
 * @returns 首个成环的候选边及其环路径；无环返回 null
 */
export function detectCycle(graph, candidateEdges) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];

  // 候选边叠加到图上（不修改原图）
  const candidateFrom = new Map(); // source -> Set(target)
  for (const c of candidateEdges) {
    let set = candidateFrom.get(c.sourceFieldId);
    if (!set) {
      set = new Set();
      candidateFrom.set(c.sourceFieldId, set);
    }
    set.add(c.targetFieldId);
  }
  // 批次内自环 / 批次内直接重复成环
  for (const c of candidateEdges) {
    if (c.sourceFieldId === c.targetFieldId) {
      return { edge: c, cycle: [c.sourceFieldId, c.targetFieldId] };
    }
  }
  const neighbors = (node) => {
    const list = [...(graph.get(node) ?? [])];
    for (const t of candidateFrom.get(node) ?? []) list.push(t);
    return list;
  };

  function dfs(node) {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of neighbors(node)) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const cycleStart = stack.indexOf(next);
        return [...stack.slice(cycleStart), next];
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  const starts = new Set([...graph.keys()]);
  for (const c of candidateEdges) starts.add(c.sourceFieldId);
  for (const node of starts) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const cycle = dfs(node);
      if (cycle) {
        const last = cycle[cycle.length - 2];
        const first = cycle[cycle.length - 1];
        const edge = candidateEdges.find((c) => c.sourceFieldId === last && c.targetFieldId === first)
          ?? candidateEdges.find((c) => c.sourceFieldId === first && graph.get(first)?.has(last))
          ?? candidateEdges[0];
        return { edge, cycle };
      }
    }
  }
  return null;
}

/**
 * 下游闭包：从一组字段出发，沿 source -> target 方向收集全部可达字段。
 * @returns Map<fieldId, { distance: number, path: string[] }>
 */
export function downstreamClosure(state, seedFieldIds) {
  const graph = buildFieldGraph(state);
  const result = new Map();
  const queue = [];
  for (const id of seedFieldIds) {
    if (!result.has(id)) {
      result.set(id, { distance: 0, path: [id] });
      queue.push(id);
    }
  }
  while (queue.length) {
    const node = queue.shift();
    const nodeInfo = result.get(node);
    for (const next of graph.get(node) ?? []) {
      if (!result.has(next)) {
        result.set(next, { distance: nodeInfo.distance + 1, path: [...nodeInfo.path, next] });
        queue.push(next);
      }
    }
  }
  return result;
}

/** 上游闭包：沿 target -> source 反向收集（血缘图页面用） */
export function upstreamClosure(state, seedFieldIds) {
  const reverse = new Map();
  for (const edge of state.edges) {
    if (edge.inactive) continue;
    let set = reverse.get(edge.targetFieldId);
    if (!set) {
      set = new Set();
      reverse.set(edge.targetFieldId, set);
    }
    set.add(edge.sourceFieldId);
  }
  const result = new Map();
  const queue = [];
  for (const id of seedFieldIds) {
    if (!result.has(id)) {
      result.set(id, { distance: 0, path: [id] });
      queue.push(id);
    }
  }
  while (queue.length) {
    const node = queue.shift();
    const nodeInfo = result.get(node);
    for (const next of reverse.get(node) ?? []) {
      if (!result.has(next)) {
        result.set(next, { distance: nodeInfo.distance + 1, path: [...nodeInfo.path, next] });
        queue.push(next);
      }
    }
  }
  return result;
}
