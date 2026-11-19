/* 字段级血缘控制台：原生 JS，无构建依赖 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- API ----------
async function api(method, route, body) {
  const res = await fetch(route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }
  return json.data;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 4200);
}

const TYPE_COLOR = { source: '#34c98f', model: '#f0a93b', report: '#b47cf2' };
const STATUS_LABEL = {
  blocked: '阻断', pending: '待处理', in_progress: '进行中', done: '已完成', wont_migrate: '不迁移',
};

// ---------- Tabs ----------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'impact') renderImpacts();
    if (tab.dataset.tab === 'diff') $('#diff-to').value = window.__health?.lineageVersion ?? '';
  });
});

// ---------- 健康状态 ----------
async function loadHealth() {
  const h = await api('GET', '/api/health');
  window.__health = h;
  $('#health').innerHTML =
    `血缘版本 <b>v${h.lineageVersion}</b><br>` +
    `对象 <b>${h.objectCount}</b> · 字段 <b>${h.fieldCount}</b> · 血缘边 <b>${h.edgeCount}</b> · 影响分析 <b>${h.impactCount}</b>`;
  return h;
}

// ---------- 血缘图（SVG 分层布局） ----------
let cachedGraph = null;

async function loadGraph(snapshotVersion = '') {
  const q = snapshotVersion ? `?atLineageVersion=${snapshotVersion}` : '';
  cachedGraph = await api('GET', `/api/lineage/graph${q}`);
  renderGraph(cachedGraph);
}

function renderGraph(data) {
  const svg = $('#lineage-svg');
  svg.innerHTML = '';
  if (!data.nodes?.length) {
    svg.innerHTML = '<text x="20" y="40" fill="#8fa0bd">暂无血缘数据，请先在登记台注册。</text>';
    svg.setAttribute('width', 900);
    svg.setAttribute('height', 480);
    return;
  }

  // 分层：按对象类型 source -> model -> report；同层按对象名分组
  const layerOf = (t) => (t === 'source' ? 0 : t === 'model' ? 1 : 2);
  const nodes = data.nodes;
  const layers = [[], [], []];
  for (const n of nodes) layers[layerOf(n.objectType)].push(n);

  const NODE_W = 190;
  const NODE_H = 54;
  const GAP_X = 70;
  const GAP_Y = 26;
  const PAD = 30;
  // 每层节点纵向排列，同对象字段连续
  const pos = new Map();
  let maxRows = 0;
  layers.forEach((layer, li) => {
    layer.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.fieldName.localeCompare(b.fieldName));
    layer.forEach((n, idx) => {
      const x = PAD + li * (NODE_W + GAP_X);
      const y = PAD + idx * (NODE_H + GAP_Y);
      pos.set(n.fieldId, { x, y });
    });
    maxRows = Math.max(maxRows, layer.length);
  });
  const width = PAD * 2 + 3 * NODE_W + 2 * GAP_X;
  const height = PAD * 2 + maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y;
  svg.setAttribute('width', width);
  svg.setAttribute('height', Math.max(480, height));
  svg.setAttribute('viewBox', `0 0 ${width} ${Math.max(480, height)}`);

  // 箭头
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="#5a6b92"/></marker>
    <marker id="arrow-warn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="#e8b84a"/></marker>
    <marker id="arrow-danger" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="#ef5f6b"/></marker>`;
  svg.appendChild(defs);

  // 边（先画边，节点覆盖在上面）
  const edgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const e of data.edges) {
    const s = pos.get(e.sourceFieldId);
    const t = pos.get(e.targetFieldId);
    if (!s || !t) continue;
    const x1 = s.x + NODE_W;
    const y1 = s.y + NODE_H / 2;
    const x2 = t.x;
    const y2 = t.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const drift = e.sourceVersionDrift || e.targetVersionDrift;
    const blocked = e.migrationStatus === 'blocked';
    path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`);
    path.setAttribute('class', `edge-path ${blocked ? 'blocked' : drift ? 'drift' : ''}`);
    path.setAttribute('marker-end', blocked ? 'url(#arrow-danger)' : drift ? 'url(#arrow-warn)' : 'url(#arrow)');
    path.dataset.edgeId = e.edgeId;
    path.style.cursor = 'pointer';
    path.addEventListener('click', () => showEdgeDetail(e));
    edgeLayer.appendChild(path);

    // 表达式标签（截断）
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', mx);
    label.setAttribute('y', (y1 + y2) / 2 - 4);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'edge-label');
    const expr = e.transformExpression || '直接映射';
    label.textContent = expr.length > 22 ? `${expr.slice(0, 21)}…` : expr;
    edgeLayer.appendChild(label);
  }
  svg.appendChild(edgeLayer);

  // 节点
  const nodeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const n of nodes) {
    const { x, y } = pos.get(n.fieldId);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `node ${n.status === 'deleted' ? 'deleted' : ''}`);
    const color = TYPE_COLOR[n.objectType] ?? '#8fa0bd';
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 8);
    rect.setAttribute('fill', '#1e2740');
    rect.setAttribute('stroke', n.status === 'deleted' ? '#ef5f6b' : color);
    g.appendChild(rect);

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    title.setAttribute('x', x + 12);
    title.setAttribute('y', y + 22);
    title.textContent = `${n.objectName}.${n.fieldName}`;
    g.appendChild(title);

    const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    sub.setAttribute('x', x + 12);
    sub.setAttribute('y', y + 40);
    sub.setAttribute('class', 'vtag');
    const parts = [`fieldVersion v${n.fieldVersion}`];
    if (n.status === 'deleted') parts.push('已删除');
    if (n.upstreamDistance != null && n.downstreamDistance != null && n.upstreamDistance === 0 && n.downstreamDistance === 0) {
      parts.push('聚焦中心');
    }
    sub.textContent = parts.join(' · ');
    g.appendChild(sub);

    g.addEventListener('click', () => focusField(n.fieldId));
    nodeLayer.appendChild(g);
  }
  svg.appendChild(nodeLayer);
}

async function focusField(fieldId) {
  const focused = await api('GET', `/api/lineage/graph?fieldId=${fieldId}`);
  cachedGraph = focused;
  renderGraph(focused);
  $('#btn-reset-focus').hidden = false;
  const center = focused.nodes.find((n) => n.fieldId === fieldId);
  $('#focus-hint').textContent = `已聚焦：${center.objectName}.${center.fieldName}（上游 ${focused.nodes.filter((n) => (n.upstreamDistance ?? 0) > 0).length} / 下游 ${focused.nodes.filter((n) => (n.downstreamDistance ?? 0) > 0).length}），点击节点继续追踪`;
}

$('#btn-reset-focus').addEventListener('click', async () => {
  $('#btn-reset-focus').hidden = true;
  $('#focus-hint').textContent = '';
  await loadGraph($('#snapshot-version').value);
});

function showEdgeDetail(e) {
  const el = $('#edge-detail');
  el.hidden = false;
  const driftLine =
    (e.sourceVersionDrift ? `<li>来源字段版本漂移：注册时钉选 <b>v${e.sourceFieldVersion}</b>，当前字段已变更</li>` : '') +
    (e.targetVersionDrift ? `<li>目标字段版本漂移：注册时钉选 <b>v${e.targetFieldVersion}</b>，当前字段已变更</li>` : '');
  el.innerHTML = `
    <h4>血缘边详情（批次 ${e.batchId}）</h4>
    <div class="kv">
      <span class="k">来源字段</span><span><code>${e.sourceObjectName}.${e.sourceFieldName}</code> 钉选版本 <b>v${e.sourceFieldVersion}</b>${e.sourceStatus === 'deleted' ? ' <span class="pill deleted">已删除</span>' : ''}</span>
      <span class="k">目标字段</span><span><code>${e.targetObjectName}.${e.targetFieldName}</code> 钉选版本 <b>v${e.targetFieldVersion}</b></span>
      <span class="k">转换表达式</span><span><code>${e.transformExpression || '直接映射'}</code></span>
      <span class="k">表达式引用</span><span>${(e.expressionRefs ?? []).map((r) => `<code>${r.objectId}.${r.fieldName}</code>`).join(' ') || '—'}</span>
      <span class="k">迁移状态</span><span>${e.migrationStatus ? `<span class="status-pill status-${e.migrationStatus}">${STATUS_LABEL[e.migrationStatus]}</span>` : '无迁移单'}</span>
    </div>
    ${driftLine ? `<ul class="reasons" style="color:var(--warn)">${driftLine}</ul>` : ''}
  `;
}

// 快照版本下拉
async function loadVersionOptions() {
  const batches = await api('GET', '/api/lineage/batches');
  const sel = $('#snapshot-version');
  const current = sel.value;
  sel.innerHTML = '<option value="">当前最新</option>' +
    batches.map((b) => `<option value="${b.lineageVersion}">v${b.lineageVersion}（${b.edgeCount} 条边 · ${new Date(b.at).toLocaleString('zh-CN')}）</option>`).join('');
  sel.value = current;
}
$('#snapshot-version').addEventListener('change', (ev) => loadGraph(ev.target.value));

// ---------- 版本差异 ----------
$('#btn-diff').addEventListener('click', async () => {
  const from = $('#diff-from').value;
  const to = $('#diff-to').value;
  const params = new URLSearchParams();
  if (from !== '') params.set('fromVersion', from);
  if (to !== '') params.set('toVersion', to);
  const d = await api('GET', `/api/versions/diff?${params}`);
  const edgeRow = (e, kind) => `
    <tr>
      <td><span class="pill ${kind}">${kind === 'added' ? '新增' : '移除'}</span></td>
      <td><code>${e.sourceObjectName}.${e.sourceFieldName}@v${e.sourceFieldVersion}</code></td>
      <td>→</td>
      <td><code>${e.targetObjectName}.${e.targetFieldName}@v${e.targetFieldVersion}</code></td>
      <td><code>${e.transformExpression || '直接映射'}</code></td>
      <td>v${d.fromVersion} → v${d.toVersion}</td>
    </tr>`;
  const changeLabel = { created: '新建', renamed: '改名', deleted: '删除' };
  $('#diff-result').innerHTML = `
    <div class="diff-section">
      <h3>血缘边变化（${d.edgeAdded.length} 新增 / ${d.edgeRemoved.length} 移除）</h3>
      <table>
        <thead><tr><th>类型</th><th>来源（钉选版本）</th><th></th><th>目标（钉选版本）</th><th>转换表达式</th><th>版本区间</th></tr></thead>
        <tbody>
          ${d.edgeAdded.map((e) => edgeRow(e, 'added')).join('')}
          ${d.edgeRemoved.map((e) => edgeRow(e, 'removed')).join('') || '<tr><td colspan="6" class="empty">无变化</td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="diff-section">
      <h3>字段变化（${d.fieldChanges.length}）</h3>
      <table>
        <thead><tr><th>类型</th><th>对象</th><th>字段</th><th>名称变化</th><th>字段版本</th></tr></thead>
        <tbody>
          ${d.fieldChanges.map((c) => `
            <tr>
              <td><span class="pill ${c.change}">${changeLabel[c.change]}</span></td>
              <td>${c.objectName ?? '—'}</td>
              <td><code>${c.fieldName}</code></td>
              <td>${c.fromName ? `<code>${c.fromName}</code> → <code>${c.toName ?? '∅'}</code>` : '—'}</td>
              <td>${c.fromVersion == null ? '—' : `v${c.fromVersion}`} → <b>v${c.toVersion}</b></td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">无变化</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="hint">区间内批次：${d.batchesInRange.map((b) => `v${b.lineageVersion}(${b.batchId.slice(0, 12)}…)`).join('，') || '无'}</p>
  `;
});

// ---------- 影响与迁移 ----------
async function renderImpacts() {
  const impacts = await api('GET', '/api/impacts');
  const wrap = $('#impact-list');
  if (!impacts.length) {
    wrap.innerHTML = '<div class="empty">暂无影响分析。在登记台对字段执行改名或删除后自动生成。</div>';
    return;
  }
  wrap.innerHTML = impacts.map((im) => {
    const p = im.progress;
    const seg = (key) => (p[key] ? `<div class="seg ${key}" style="flex:${p[key]}" title="${STATUS_LABEL[key]} ${p[key]}"></div>` : '');
    return `
    <div class="impact-card" data-impact="${im.impactId}">
      <div class="impact-head">
        <h3>${im.changeType === 'rename' ? '字段改名' : '字段删除'}：<code>${im.objectName}.${im.fromName}</code>${im.toName ? ` → <code>${im.toName}</code>` : ''}</h3>
        <span class="pill ${im.changeType === 'rename' ? 'renamed' : 'deleted'}">fieldVersion v${im.fieldVersion}</span>
        <span class="hint">血缘版本 v${im.atLineageVersion} · ${new Date(im.createdAt).toLocaleString('zh-CN')}${im.reason ? ` · 原因：${im.reason}` : ''}</span>
      </div>
      <div class="meta-grid">
        <div class="cell"><div class="k">受影响字段</div><div class="v">${im.affectedFieldCount}</div></div>
        <div class="cell"><div class="k">受影响对象</div><div class="v">${im.affectedObjects.map((o) => o.objectName).join('、') || '无'}</div></div>
        <div class="cell"><div class="k">迁移单</div><div class="v">${p.total}</div></div>
        <div class="cell"><div class="k">完成率</div><div class="v">${(p.completionRate * 100).toFixed(0)}%（${p.finished}/${p.total}）</div></div>
      </div>
      <div class="progress-wrap">${seg('blocked')}${seg('pending')}${seg('in_progress')}${seg('done')}${seg('wont_migrate')}</div>
      <div class="progress-label">阻断 ${p.blocked} · 待处理 ${p.pending} · 进行中 ${p.in_progress} · 完成 ${p.done} · 不迁移 ${p.wont_migrate}</div>

      <h4 style="margin:14px 0 6px">受影响字段与传播路径</h4>
      <table>
        <thead><tr><th>对象</th><th>字段</th><th>层级</th><th>状态</th><th>传播路径</th></tr></thead>
        <tbody>
          ${im.affectedFields.map((f) => `
            <tr>
              <td>${f.objectName} <span class="hint">(${f.objectType})</span></td>
              <td><code>${f.fieldName}</code></td>
              <td>下游第 ${f.distance} 层</td>
              <td>${f.status === 'deleted' ? '<span class="pill deleted">已删除</span>' : '<span class="pill created">存活</span>'}</td>
              <td class="path-chain">${f.path.join(' → ')}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="empty">无下游字段</td></tr>'}
        </tbody>
      </table>

      <h4 style="margin:14px 0 6px">迁移单与阻断原因</h4>
      ${im.migrations.map((m) => `
        <div class="migration" data-edge="${m.edgeId}">
          <div class="row">
            <span>目标 <code>${m.targetObjectName}.${m.targetFieldName}</code></span>
            <span class="hint">表达式 <code>${m.transformExpression || '直接映射'}</code></span>
            <span class="hint">来源钉选版本 v${m.pinnedSourceFieldVersion}</span>
            <span class="status-pill status-${m.status}">${STATUS_LABEL[m.status]}</span>
          </div>
          ${m.blockingReasons.length ? `<ul class="reasons">${m.blockingReasons.map((r) => `<li>阻断原因：${r}</li>`).join('')}</ul>` : ''}
          <div class="row">
            <span class="hint">可用替代字段：</span>
            <span class="alts">
              ${m.alternatives.map((a) => `<span class="alt" data-alt="${a.fieldId}" title="${a.matchReason}（评分 ${a.score}）">${a.name} <span class="hint">${a.dataType} · ${a.score}分</span></span>`).join('') || '<span class="hint">无候选</span>'}
            </span>
            ${m.altSourceFieldId ? `<span class="hint">已改引：<code>${m.altSourceFieldId}</code></span>` : ''}
          </div>
          <div class="row">
            <button class="small ghost" data-act="pending" ${m.status === 'blocked' || m.status === 'in_progress' || m.status === 'wont_migrate' ? '' : 'disabled'}>解除阻断/待处理</button>
            <button class="small" data-act="in_progress" ${m.status === 'pending' || m.status === 'done' ? '' : 'disabled'}>进行中</button>
            <button class="small" data-act="done" style="background:var(--ok)" ${m.status === 'pending' || m.status === 'in_progress' ? '' : 'disabled'}>完成迁移</button>
            <button class="small ghost" data-act="wont_migrate" ${m.status === 'blocked' || m.status === 'pending' || m.status === 'in_progress' ? '' : 'disabled'}>不迁移</button>
          </div>
          <ul class="history">
            ${m.history.map((h) => `<li>${new Date(h.at).toLocaleString('zh-CN')}：${h.fromStatus ?? '∅'} → ${h.toStatus}${h.reason ? `（${h.reason}）` : ''}</li>`).join('')}
          </ul>
        </div>`).join('') || '<p class="hint">该变更没有直接消费字段，无需迁移。</p>'}
    </div>`;
  }).join('');

  // 迁移操作
  wrap.querySelectorAll('.migration').forEach((box) => {
    const edgeId = box.dataset.edge;
    box.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const status = btn.dataset.act;
        let reason = '';
        if (status === 'pending') {
          reason = prompt('请填写解除阻断 / 退回待处理的说明：') ?? '';
          if (reason === null) return;
        }
        try {
          await api('POST', `/api/migrations/${edgeId}/status`, { status, reason });
          toast(`迁移单已切换为「${STATUS_LABEL[status]}」`, 'success');
          await renderImpacts();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
    box.querySelectorAll('.alt').forEach((alt) => {
      alt.addEventListener('click', async () => {
        const reason = prompt(`确认改引到替代字段 ${alt.textContent.trim()}，填写说明：`) ?? '';
        if (reason === null) return;
        try {
          await api('POST', `/api/migrations/${edgeId}/remap`, { alternativeFieldId: alt.dataset.alt, reason });
          toast('已改引替代字段，阻断自动解除', 'success');
          await renderImpacts();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  });
}

// ---------- 登记台 ----------
async function refreshSelectors() {
  const [objects, fields] = await Promise.all([
    api('GET', '/api/objects'),
    api('GET', '/api/fields'),
  ]);
  const active = fields.filter((f) => f.status === 'active');
  const fieldLabel = (f) => `${f.objectName}.${f.fieldName} (v${f.fieldVersion}, ${f.dataType})`;

  $('#form-field select[name="objectId"]').innerHTML =
    objects.map((o) => `<option value="${o.objectId}">${o.name} (${o.type})</option>`).join('');
  const fieldOpts = active.map((f) => `<option value="${f.fieldId}">${fieldLabel(f)}</option>`).join('');
  $('#form-lineage select[name="sourceFieldId"]').innerHTML = fieldOpts;
  $('#form-lineage select[name="targetFieldId"]').innerHTML = fieldOpts;
  $('#change-field').innerHTML = fields.map((f) =>
    `<option value="${f.fieldId}" ${f.status === 'deleted' ? 'disabled' : ''}>${fieldLabel(f)}${f.status === 'deleted' ? '（已删除）' : ''}</option>`).join('');
  window.__fields = fields;
}

$('#form-object').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    const obj = await api('POST', '/api/objects', Object.fromEntries(fd));
    toast(`对象已注册：${obj.name}（${obj.objectId}）`, 'success');
    ev.target.reset();
    await refreshSelectors();
  } catch (err) { toast(err.message, 'error'); }
});

$('#form-field').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  try {
    const f = await api('POST', '/api/fields', Object.fromEntries(fd));
    toast(`字段已注册：${f.fieldName}，fieldVersion=v1`, 'success');
    ev.target.reset();
    await refreshSelectors();
  } catch (err) { toast(err.message, 'error'); }
});

// 批次暂存
const batchEntries = [];
$('#form-lineage').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const entry = Object.fromEntries(fd);
  const fields = window.__fields ?? [];
  const s = fields.find((f) => f.fieldId === entry.sourceFieldId);
  const t = fields.find((f) => f.fieldId === entry.targetFieldId);
  batchEntries.push(entry);
  const tbody = $('#batch-entries tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${batchEntries.length}</td><td>${s ? `${s.objectName}.${s.fieldName}` : entry.sourceFieldId}</td>
    <td>${t ? `${t.objectName}.${t.fieldName}` : entry.targetFieldId}</td>
    <td><code>${entry.transformExpression}</code></td>
    <td><button class="small ghost" type="button">移除</button></td>`;
  tr.querySelector('button').addEventListener('click', () => {
    const idx = batchEntries.indexOf(entry);
    batchEntries.splice(idx, 1);
    tr.remove();
  });
  tbody.appendChild(tr);
  ev.target.reset();
});

$('#btn-clear-batch').addEventListener('click', () => {
  batchEntries.length = 0;
  $('#batch-entries tbody').innerHTML = '';
  $('#batch-result').innerHTML = '';
});

$('#btn-submit-batch').addEventListener('click', async () => {
  if (!batchEntries.length) return toast('批次为空，请先加入血缘条目', 'error');
  try {
    const res = await api('POST', '/api/lineage/batches', { entries: batchEntries });
    const rows = res.results.map((r) => `
      <tr>
        <td>${r.index + 1}</td>
        <td><span class="pill ${r.status === 'ok' ? 'added' : r.status === 'failed' ? 'removed' : 'renamed'}">${r.status === 'ok' ? '已提交' : r.status === 'failed' ? '失败' : '跳过'}</span></td>
        <td>${r.reason ?? '—'}</td>
      </tr>`).join('');
    $('#batch-result').innerHTML = `
      <div class="batch-summary">
        <span class="summary-item">批次 <b>${res.batchId ? res.batchId.slice(0, 12) + '…' : '未生成'}</b></span>
        <span class="summary-item">血缘版本 <b>v${res.lineageVersion}</b></span>
        <span class="summary-item result-ok">提交 <b>${res.committedCount}</b></span>
        <span class="summary-item result-failed">失败 <b>${res.failedCount}</b></span>
        <span class="summary-item result-skipped">跳过 <b>${res.skippedCount}</b></span>
      </div>
      <table><thead><tr><th>#</th><th>结果</th><th>原因</th></tr></thead><tbody>${rows}</tbody></table>`;
    toast(`批次处理完成：提交 ${res.committedCount} / 失败 ${res.failedCount} / 跳过 ${res.skippedCount}`,
      res.failedCount ? 'error' : 'success');
    batchEntries.length = 0;
    $('#batch-entries tbody').innerHTML = '';
    await Promise.all([refreshSelectors(), loadVersionOptions(), loadGraph($('#snapshot-version').value), loadHealth()]);
  } catch (err) { toast(err.message, 'error'); }
});

// 改名 / 删除
$('#btn-rename').addEventListener('click', async () => {
  const fieldId = $('#change-field').value;
  const newName = $('#change-new-name').value.trim();
  if (!newName) return toast('改名必须填写新字段名', 'error');
  try {
    const r = await api('POST', `/api/fields/${fieldId}/rename`, { newName, reason: $('#change-reason').value });
    toast(`改名完成，生成影响分析 ${r.impact.impactId.slice(0, 10)}…：受影响字段 ${r.impact.affectedFieldCount} 个`, 'success');
    $('#change-new-name').value = '';
    await afterChange();
  } catch (err) { toast(err.message, 'error'); }
});

$('#btn-delete').addEventListener('click', async () => {
  const fieldId = $('#change-field').value;
  if (!confirm('确认删除该字段？将自动生成影响分析与迁移单。')) return;
  try {
    const r = await api('POST', `/api/fields/${fieldId}/delete`, { reason: $('#change-reason').value });
    toast(`删除完成，生成影响分析：受影响字段 ${r.impact.affectedFieldCount} 个，迁移单 ${r.impact.migrations.length} 条`, 'success');
    await afterChange();
  } catch (err) { toast(err.message, 'error'); }
});

async function afterChange() {
  await Promise.all([refreshSelectors(), loadVersionOptions(), loadGraph($('#snapshot-version').value), loadHealth()]);
}

// ---------- 启动 ----------
(async function boot() {
  try {
    await loadHealth();
    await Promise.all([refreshSelectors(), loadVersionOptions(), loadGraph()]);
  } catch (err) {
    toast(`初始化失败：${err.message}`, 'error');
  }
})();
