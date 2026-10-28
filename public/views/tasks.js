/**
 * 历史会话面板的视图层：状态文案、行与分组的模板、清理数字的派生。
 * 纯函数，不碰 DOM、不读全局状态 —— 输入由调用方（app.js）组装。
 *
 * 与 views/files.js 同一条规矩：这一层能被 node --test 直接喂夹具断言
 * 产出的 HTML，重排模板不再靠"在源码里找字符串"来验证。
 */

import { esc, icon, bytesTip, bytesB, shortPath, fmtDate, fmtDateTime } from './shared.js';
import { fmtBytes } from '../logic.js';

/* ── 状态字典 ─────────────────────────────────────────────── */

/**
 * 可清理 = 后端给出了 reason。判定只在服务端做一次，前端照着用。
 * 各 app 给出的 reason 不完全一样（ZCode 有"界面已删除"，Codex 没有；
 * Cursor 一条都不给 —— 它按可达性分析删，删活跃会话是自洽的）。
 */
export const isPurgeable = (t) => t.reason != null;

export const REASON_LABEL = {
  deleted:     '已在界面删除',
  archived:    '已归档',
  wsMissing:   '工作区已丢失',
  untracked:   '界面不可见',
  bodyMissing: '正文已丢失',
  empty:       '空文件',
  /* Cursor 专属：会话本身正常，可清理是因为它按可达性分析删 —— 删一条活跃
     会话是自洽的，不留下任何悬空引用。别的工具没有这个档。 */
  manual:      '可手动清理',
};

export const REASON_TONE = {
  deleted: 'st-serious', archived: 'st-warning', wsMissing: 'st-serious',
  untracked: 'st-serious', bodyMissing: 'st-serious', empty: 'st-serious',
  manual: 'st-warning',
};

export const STATE_TONE = { deleted: 'st-serious', archived: 'st-warning', active: 'st-good', untracked: 'st-warning', empty: 'st-serious' };

export const STATE_META_CN = {
  deleted: '已删除会话', archived: '已归档会话', active: '活跃会话',
  untracked: '界面不可见', empty: '空文件',
};

export const STATUS_CLASS_TONE = { 'st-serious': 'st-serious', 'st-warning': 'st-warning', 'st-good': 'st-good', 'st-critical': 'st-critical' };

export const stateLabel = (t) => t.reason ? REASON_LABEL[t.reason] : STATE_META_CN[t.state];
export const stateTone = (t) => t.reason ? REASON_TONE[t.reason] : STATE_TONE[t.state];

/* ── 会话的「所属内容」 ─────────────────────────────────────
 * 后端为每条会话枚举出"删掉它会带走什么"（lib/session-contents.mjs），
 * 这里把它翻成人话。为什么要分角色：五种工具的级联范围差得极远 ——
 * ZCode 牵连四类目录，Claude 就一个文件。看着同一行"清理"，实际后果不同，
 * 用户在下手前必须看得见差别。
 *
 * 角色的值域与后端 CONTENT_ROLES 一一对应，测试双向锁死。 */
export const CONTENT_ROLE_LABEL = {
  body:       '正文',
  segment:    '分页续段',
  media:      '会话贴图',
  transcript: '子 Agent 记录',
  log:        '命令日志',
  artifact:   '会话产物',
  projection: '投影缓存',
  lock:       '会话锁',
  index:      '索引行',
};

/** 这类内容为什么必须跟着会话一起删 —— 只在有话说的时候出现。 */
export const CONTENT_ROLE_NOTE = {
  segment: '分页段必须整组删除：留一段残骸，恢复时会报 missing source rollout',
  projection: '投影不删的话，下次启动还会显示一个没有正文的空壳',
};

/**
 * 会话详情里的「所属内容」清单。
 *
 * 三块：库行（会走事务删除）、文件（会进废纸篓）、提示（不可删或需知会）。
 * 空清单整块不出现 —— 显示一个"0 项"的假清单比不显示更让人困惑。
 */
export function taskContentsHtml(t) {
  const c = t.contents;
  if (!c) return '';
  const files = mergeByRole(c.files || []);
  const rows = rowTotal(c.dbRows);
  const blobBytes = c.blobs?.bytes || 0;
  if (!files.length && !rows && !blobBytes) {
    return c.notes?.length ? noteList(c.notes) : '';
  }

  const lines = files.map((f) => {
    const where = f.count > 1
      ? `<code>${esc(f.rel)}/</code><span class="tcontent-n">${f.count.toLocaleString()} 个文件</span>`
      : `<code>${esc(f.rel)}</code>`;
    const note = CONTENT_ROLE_NOTE[f.role];
    return `<div class="tcontent-row">
      <dt>${esc(CONTENT_ROLE_LABEL[f.role] || f.role)}</dt>
      <dd title="${esc(f.rel)}${f.removable ? '' : '（不随会话删除）'}">
        ${where}
        <span class="tcontent-size">${f.removable ? bytesB(f.bytes) : '不删'}</span>
        ${note && f.role !== 'projection' ? '' : ''}
      </dd>
    </div>`;
  });

  const dbLine = rows
    ? `<div class="tcontent-row">
        <dt>数据库</dt>
        <dd><span class="tcontent-n">${c.dbRows.length} 张表 · ${rows.toLocaleString()} 行</span>
          <span class="tcontent-note">由事务删除，删前自动备份</span></dd>
      </div>`
    : '';
  const blobLine = blobBytes
    ? `<div class="tcontent-row">
        <dt>独占内容</dt>
        <dd><span class="tcontent-n">${(c.blobs.count || 0).toLocaleString()} 个只被这条会话引用的工具结果</span>
          <span class="tcontent-size">${bytesB(blobBytes)}</span></dd>
      </div>`
    : '';

  const total = files.filter((f) => f.removable).reduce((s, f) => s + f.bytes, 0) + blobBytes;
  return `<div class="tcontents">
    <span class="tcontents-title">所属内容</span>
    <dl class="tcontents-grid">${dbLine}${blobLine}${lines.join('')}</dl>
    ${total ? `<p class="tcontents-total">删除这条会话共回收 <b>${bytesB(total)}</b>${rows ? `，并从库里删 ${rows.toLocaleString()} 行` : ''}</p>` : ''}
    ${noteList(c.notes || [])}
  </div>`;
}

function rowTotal(dbRows) {
  return (dbRows || []).reduce((s, r) => s + (r.count || 0), 0);
}

function noteList(notes) {
  if (!notes.length) return '';
  return `<ul class="tcontent-notes">${notes.map((n) =>
    `<li class="${n.tone === 'warn' ? 'is-warn' : ''}">${esc(n.text)}</li>`).join('')}</ul>`;
}

/** 展示层压缩：同一个角色的多条路径合成一行（数据层仍保留逐条）。 */
export function mergeByRole(files) {
  const out = [];
  for (const f of files) {
    const hit = out.find((x) => x.role === f.role && x.removable === f.removable);
    if (!hit) { out.push({ ...f }); continue; }
    hit.bytes += f.bytes;
    hit.count += f.count;
    hit.rel = commonDir(hit.rel, f.rel);
  }
  return out;
}

function commonDir(a, b) {
  if (!a || !b) return '';
  const pa = a.split('/');
  const pb = b.split('/');
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    if (pa[i] !== pb[i]) break;
    out.push(pa[i]);
  }
  const joined = out.join('/');
  if (joined === a || joined === b) return out.slice(0, -1).join('/');
  return joined;
}

/** 正文即文件的那两家（Claude Code / DeepSeek）的说明。
 *  文案由适配器给（每家正文放在哪不一样），缺了退回通用的 —— 不按 app 名硬编码。
 *  口径要点：它们从**会话管理**删，不是去文件清单挑文件。 */
export const fileBasedNote = (d) =>
  `${icon('doc')}<div>${d?.fileBasedNote ||
    `${esc(d?.appLabel || '这个工具')} 的会话正文就是文件本身，没有数据库行可删。` +
    `勾选后在<b>这里</b>清理：会先备份，再把那些正文文件移入废纸篓（可随时恢复）。`}</div>`;

/* ── 选区与快捷范围的派生 ─────────────────────────────────── */

/** 勾选会话的合计：条数、正文、子会话与库内条目数。 */
export function taskSelTotals(d, sel) {
  if (!d) return { count: 0, bytes: 0, children: 0, rows: 0, picked: [] };
  const picked = d.tasks.filter((t) => sel.has(t.id));
  return {
    count: picked.length,
    bytes: picked.reduce((s, t) => s + t.bytes, 0),
    children: picked.reduce((s, t) => s + t.children, 0),
    // Codex 没有子会话这一层，能说的是库里有多少条投影条目
    rows: picked.reduce((s, t) => s + (t.rows || 0), 0),
    picked,
  };
}

/**
 * 首屏「一键清理」的范围：只动界面上删过、且确实放着没用的会话。
 * 近期还在用的（cutoff 之后）、置顶的，按开关跳过。
 */
export function taskQuickSet(d, tq) {
  if (!d) return { tasks: [], bytes: 0, total: 0, totalBytes: 0, skippedRecent: 0, skippedPinned: 0 };
  const base = d.tasks.filter((t) => t.state === 'deleted' && isPurgeable(t));
  const cutoff = tq.ageDays > 0 ? Date.now() - tq.ageDays * 86400000 : 0;
  const picked = base.filter((t) =>
    (!tq.skipPinned || !t.pinned) && (!cutoff || t.updatedAt < cutoff));
  return {
    tasks: picked,
    bytes: picked.reduce((s, t) => s + t.bytes, 0),
    total: base.length,
    totalBytes: base.reduce((s, t) => s + t.bytes, 0),
    skippedRecent: cutoff ? base.filter((t) => t.updatedAt >= cutoff).length : 0,
    skippedPinned: base.filter((t) => t.pinned).length,
  };
}

/** 筛选 + 排序后的可见会话：状态多选、标题/工作区搜索、三档排序。 */
export function visibleTasks(d, { q = '', states, sort = 'size' }) {
  if (!d) return [];
  let list = d.tasks.filter((t) => {
    if (states.size && !states.has(t.state)) return false;
    if (q && !`${t.title} ${t.workspace}`.toLowerCase().includes(q)) return false;
    return true;
  });
  return list.sort((a, b) =>
    sort === 'size' ? b.bytes - a.bytes :
    sort === 'time' ? b.updatedAt - a.updatedAt :
    a.title.localeCompare(b.title, 'zh'));
}

/** 按工作区聚合；组按正文合计降序，组内保持调用方排好的顺序。 */
export function groupTasksByWorkspace(list) {
  const byWs = new Map();
  for (const t of list) {
    const key = t.workspace || '(未知工作区)';
    let g = byWs.get(key);
    if (!g) byWs.set(key, (g = { ws: key, tasks: [], bytes: 0 }));
    g.tasks.push(t);
    g.bytes += t.bytes;
  }
  return [...byWs.values()].sort((a, b) => b.bytes - a.bytes);
}

/* ── 库构成条的计算 ───────────────────────────────────────── */

/**
 * 这些体积花在哪：按任务状态等比切开，剩下的是索引与开销。
 *
 * 分母是"库 + 库外正文"（Codex 的正文在磁盘 rollout 上，不在库里；
 * 正文即文件的工具没有库，分母就是那堆正文文件）。余量段按
 * "每一段真正占了分母多少"算，不能用 totals.bytes —— 分段里叠了
 * 库中条目体积，减错会让整排色块加起来超过 100%。
 *
 * 返回 { segs, floors, total }：segs 是过滤后的段，floors 是按最大余数法
 * 分配好的整数宽度（合计恒为 100，屏幕上不会出现 99.4% 的总宽）。
 */
export function dbBarSegments(d) {
  const bodies = d.db?.bodies?.bytes || 0;
  const total = (d.db?.total || 0) + bodies;
  const byState = (d.totals?.byState || []).map((g) => ({
    // 兜底：将来后端多一个状态桶而前端没跟上时，退化成可读的词，而不是 undefined
    label: STATE_META_CN[g.state] || g.state, bytes: g.bytes, tone: STATE_TONE[g.state] || '', key: g.state,
  }));
  const used = byState.reduce((s, g) => s + g.bytes, 0);
  const segs = [
    ...byState,
    {
      label: d.fileBased ? '未归入会话的文件' : (bodies ? '索引库与其余开销' : '索引与其他开销'),
      bytes: Math.max(0, total - used), tone: 'is-neutral', key: 'overhead',
      // 这一块是技术性的：库文件不只有正文。名字写在块上，解释挂在 tooltip 里。
      tip: d.fileBased
        ? '这个工具没有会话库 —— 分母是磁盘上的正文文件。这一段是既不属于任何会话、也不在统计里的部分。'
        : bodies
          ? '索引库文件里不属于任何会话正文的部分 —— thread_items 的索引、WAL、已释放的空页与页对齐。删掉会话后它才会跟着缩。'
          : '数据库文件里不属于任何任务正文的部分 —— 索引、已释放的空页、页对齐等。删掉任务后它才会跟着缩。',
    },
  ].filter((s) => s.bytes > 0);

  const W = 100;
  // WAL 尚未合入主库时，逻辑正文可能超过磁盘主库大小；条宽按已展示段归一化。
  // total 继续保留原始磁盘口径，不伪造额外的磁盘占用。
  const scale = segs.reduce((sum, s) => sum + s.bytes, 0);
  const pct = segs.map((s) => (scale ? (s.bytes / scale) * W : 0));
  const floors = pct.map(Math.floor);
  let rest = Math.round(W - floors.reduce((a, b) => a + b, 0));
  const order = pct.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floors[order[k][1]] += 1;
  return { segs, floors, total };
}

/* ── 模板 ─────────────────────────────────────────────────── */

/**
 * 一条会话行（含展开后的详情）。
 *
 * ctx 需要：sel（是否勾选）、open（是否展开详情）、exclusive（Cursor 的
 * 独占 blob 分析结果，可为 undefined）。
 */
export function taskRowHtml(t, ctx) {
  const { sel, open, exclusive: ex } = ctx;
  /* 分页续段：这个 .jsonl 只是会话的一段。Codex 恢复时要求完整血统，
     删掉任何一段都会让整条会话永久不可恢复 —— 而且它报的是
     "missing source rollout"，看着像别处坏了。行上必须说出来。 */
  const segNote = t.lineage?.continuation
    ? `分页第 ${t.lineage.endOrdinal} 段起`
    : t.lineage?.referenced ? '被分页续段引用' : '';
  const meta = [
    ctx.showWorkspace ? shortPath(t.workspace) : '',
    `${fmtDate(t.updatedAt)} 最后使用`,
    t.model ? t.model : '',
    t.children ? `${t.children} 子会话` : '',
    t.typeLabel,
    segNote,
  ].filter(Boolean).join('、');
  /* 以前这里有一个「在文件清单中定位」按钮：正文还在文件清单里时，
     跳过去能顺手勾选清理。会话正文移出清单之后，那个按钮只会把人带到
     一个搜不出结果的搜索框 —— 按钮删了，正文的位置改由下面的
     「所属内容」交代，删除也由会话抽屉的级联统一做。 */
  /* Cursor 的"连带回收"不进清单行 —— 行里那一行 meta 已经装了状态、
     最后使用、子会话、类型，右侧体积列也要留给主数字。它进**展开后的
     详情**：勾选和删除都是在看过详情之后做的决定，那个位置才是
     "删这条能省多少"该出现的地方。 */
  return `<div class="tsession ${open ? 'is-open' : ''}">
      <div class="trow ${sel ? 'is-on' : ''}" data-task="${esc(t.id)}">
        <button class="trow-caret" type="button" data-task-toggle="${esc(t.id)}"
          aria-expanded="${open}" title="${open ? '收起' : '会话详情'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
        <input type="checkbox" data-task-box="${esc(t.id)}" ${sel ? 'checked' : ''}
          ${isPurgeable(t) ? '' : 'disabled'} aria-label="选择会话 ${esc(t.title)}">
        <div class="trow-main">
          <span class="trow-title" title="${esc(t.title)}">${esc(t.title)}</span>
          <span class="trow-meta" title="${esc(t.workspace)}"><b class="trow-state-m ${stateTone(t)}">${esc(stateLabel(t))}</b>${esc(meta)}</span>
        </div>
        <span class="trow-size" title="${bytesTip(t.bytes)}">${fmtBytes(t.bytes)}</span>
      </div>
      ${open ? `<div class="tdetail" data-detail="${esc(t.id)}">
        <dl class="tdetail-grid">
          <div><dt>最后使用</dt><dd>${fmtDateTime(t.updatedAt)}</dd></div>
          <div><dt>创建</dt><dd>${fmtDateTime(t.createdAt)}</dd></div>
          <div><dt>文件夹</dt><dd title="${esc(t.workspace)}"><code>${esc(shortPath(t.workspace) || '—')}</code></dd></div>
          <div><dt>模型</dt><dd>${esc(t.model || '—')}</dd></div>
          <div class="tspan"><dt>会话 ID</dt><dd><code>${esc(t.id)}</code></dd></div>
          <div class="tspan"><dt>正文</dt><dd title="${esc(t.bodyRel || '')}"><code>${esc(t.bodyRel || '库内存储')}</code></dd></div>
          ${t.lineage?.continuation ? `<div class="tspan"><dt>血统</dt>
            <dd>分页续段：这个文件从第 <b>${t.lineage.endOrdinal.toLocaleString()}</b> 个 ordinal 起接，
              前面那段在另一个文件里。Codex 恢复会话时要顺着它往回找 ——
              <b>删掉任何一段，整条会话都再也恢复不了</b>（报 missing source rollout）。
              它在文件清单里已锁成「请勿删除」。</dd></div>` : ''}
          ${t.lineage?.referenced ? '<div class="tspan"><dt>分页依赖</dt><dd>其他续段依赖此文件，禁止单独删除；文件清单中已锁定。</dd></div>' : ''}
          ${ex && ex.exclusiveBytes > 0 ? `<div class="tspan"><dt>删除会连带回收</dt>
            <dd title="${ex.exclusiveBytes.toLocaleString()} 字节">
              <b>${fmtBytes(ex.exclusiveBytes)}</b>
              <span class="tdetail-note">（${ex.exclusiveBlobs.toLocaleString()} 个只被这条会话引用的工具结果）</span>
            </dd></div>` : ''}
        </dl>
        ${taskContentsHtml(t)}
        <div class="tdetail-acts">
          <button class="btn btn-ghost btn-sm" type="button" data-copy-id="${esc(t.id)}">复制会话 ID</button>
        </div>
      </div>` : ''}
    </div>`;
}

/** 一个工作区分组：组头始终可见，折叠时不画行。 */
export function taskGroupHtml(g, { folded, selCount, rowsHtml }) {
  const named = g.ws === '(未知工作区)';
  const base = named ? g.ws : (g.ws.split('/').filter(Boolean).pop() || g.ws);
  return `<section class="tgroup ${folded ? 'is-folded' : ''}" data-ws="${esc(g.ws)}">
      <header class="tgroup-head" data-ws-toggle="${esc(g.ws)}" role="button" tabindex="0"
        aria-expanded="${!folded}" title="${esc(g.ws)}">
        <svg class="tgroup-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        <span class="tgroup-name">
          <b>${esc(base)}</b>
          <code>${esc(shortPath(g.ws))}</code>
        </span>
        <span class="tgroup-n">${g.tasks.length} 个会话${selCount ? `，已选 ${selCount}` : ''}</span>
        <span class="tgroup-size" title="${bytesTip(g.bytes)}">${fmtBytes(g.bytes)}</span>
      </header>
      ${folded ? '' : `<div class="tgroup-body">${rowsHtml}</div>`}
    </section>`;
}

/** 回灌面板的一行。 */
export function recoverRowHtml(s, sel) {
  const meta = [
    s.workspace,
    fmtDate(s.date),
    `${s.messages} 条消息`,
    s.tools ? `${s.tools} 次工具调用` : '',
    s.workspaceResolved ? '' : '路径未还原',
  ].filter(Boolean).join('、');
  return `<label class="recover-row ${sel ? 'is-on' : ''}" data-recover-row="${esc(s.id)}">
      <input type="checkbox" data-recover-id="${esc(s.id)}" ${sel ? 'checked' : ''}
        aria-label="选择会话 ${esc(s.title)}">
      <span class="recover-main">
        <span class="recover-title" title="${esc(s.title)}">${esc(s.title)}</span>
        <span class="recover-meta" title="${esc(meta)}">${esc(meta)}</span>
      </span>
      <span class="recover-size" title="${bytesTip(s.bytes)}">${fmtBytes(s.bytes)}</span>
    </label>`;
}

/**
 * 空跑结果。两种形状分开渲染，不要硬塞成同一种：
 * ZCode/Codex 报"逐库逐表会删多少行"（perDb）；Cursor 没有外键表，
 * 它报"会话行 + 连带 blob" —— 硬塞会造出一个不存在的表名。
 */
export function dryRunHtml(data) {
  /* 正文即文件的两家（Claude / DeepSeek）没有库行，perDb 是空的 ——
     但级联会移走它们的正文文件。只显示"共 0 行"会让人以为什么都不会发生，
     实际上要删的文件都在 data.cascade / data.files 里。 */
  const fileRows = (data.files || []).map((f) => [f.rel, f.bytes]);
  const rows = Array.isArray(data.perDb) && data.perDb.length
    ? data.perDb.map((x) => [`${x.table}（${x.name}）`, x.count ?? 0])
    : Array.isArray(data.perDb) && fileRows.length
      ? fileRows.map(([k, b]) => [k, fmtBytes(b)])
      : Array.isArray(data.perDb)
        ? [['（这个工具没有数据库行可删）', 0]]
        : [
            ['会话条目（cursorDiskKV）', data.sessionRows ?? 0],
            ['会话头（composerHeaders）', data.sessions ?? 0],
            ['连带删除的工具结果 blob', data.blobs ?? 0],
          ];
  const totalRows = Array.isArray(data.perDb) ? rows.reduce((s, [, c]) => s + c, 0) : (data.sessionRows ?? 0);
  const bodies = data.bodyBytes
    ? `<br>另有 <b>${fmtBytes(data.bodyBytes)}</b> 正文在 rollout 文件里 —— 这里只删索引行，正文要等它们变成孤儿后走文件清理。`
    : data.blobBytes
      ? `<br>可回收 <b>${fmtBytes((data.sessionBytes || 0) + (data.blobBytes || 0))}</b>：` +
        `会话正文 <b>${fmtBytes(data.sessionBytes || 0)}</b> + 只被它们引用的 blob <b>${fmtBytes(data.blobBytes)}</b>。`
      : '';
  return {
    rowsHtml: rows.map(([k, c]) => `<li><span>${esc(k)}</span><span>${typeof c === 'number' ? c.toLocaleString() : esc(c)}</span></li>`).join(''),
    bodiesHtml: bodies,
    totalRows,
  };
}

/**
 * 删除后的一致性检查，说成人能读的一行。
 * ZCode 一个库给一个结论；Codex 逐库给一组；Cursor 报的是悬空引用 ——
 * 它没有外键，"外键违规"那套概念在这里不成立。
 */
export function checkLine(data) {
  if (data.dangling !== undefined) {
    return `完整性 ${data.integrity}，悬空引用 ${data.dangling} 处。`;
  }
  if (!Array.isArray(data.integrity)) {
    return `完整性 ${data.integrity}，外键违规 ${data.fkViolations}。`;
  }
  const bad = data.integrity.filter((r) => r.integrity !== 'ok' || r.fkViolations);
  if (!bad.length) return `${data.integrity.length} 个库完整性全部 ok，外键违规 0。`;
  return data.integrity.map((r) => `${r.name} ${r.integrity}/违规 ${r.fkViolations}`).join('，') + '。';
}

/* ── 面板文案矩阵 ───────────────────────────────────────────
   renderTasks 里的四段话、警示条的五分支、快捷项与清理抽屉的文案 ——
   全是"给一行数据说人话"的纯拼接，搬到这一层后 app.js 只剩
   "取数据 → 调模板 → 写 DOM"。 */

/** 面板顶部那句话。四种形态分开说，别把 A 工具的说法安到 B 头上：
 *  只读（Cursor 按键族摊开）/ 正文即文件 / 两段式（Codex：索引库 + rollout）/ 单库。 */
export function taskLedeHtml(d) {
  const who = d.appLabel;
  const text = d.totals.bytes;
  // 标题来自库里每条会话的 name 字段（Cursor 自己起的名字）。有些会话它没起名，
  // 也没有改动摘要 —— 那几条只能显示 ID。这里主动交代一句，
  // 免得人以为是工具没读到标题、或者以为界面出了 bug。
  const untitledNote = d.untitled
    ? `其中 <b>${d.untitled}</b> 条 Cursor 没有生成标题（库里没有 name 也没有改动摘要），按 ID 显示。`
    : '';
  /* 上面那根条按 state 分段，而"能不能清"看的是 reason —— 两个轴。
     Cursor 与 DeepSeek 的活跃会话也给勾（删它们是自洽的），此时条上只有
     「活跃会话」四个字，看起来像"一个都不能动"。这里把可清的数量明说出来，
     免得人去条上找一个不存在的"可清理"段。只在"全部可清"或"部分可清"时补，
     全都不清时不啰嗦（那种情况条上的分段本身就说清了）。 */
  const purgeable = (d.tasks || []).filter(isPurgeable).length;
  const purgeNote = !d.readOnly && purgeable > 0
    ? (purgeable === d.totals.count
      ? `这 ${purgeable} 条都可以清 —— 条上按生命周期分段，不是按能不能清。`
      : `其中 <b>${purgeable}</b> 条可以清（勾选框没灰的就是）。`)
    : '';
  const del = (d.totals.byState || []).find((g) => g.state === 'deleted');

  return d.readOnly
    ? `${esc(who)} 的会话库 ${bytesB(d.db.total)}，读到 <b>${d.totals.count}</b> 个会话、` +
      `${bytesB(text)} 的正文。下面按键族摊开这 ${fmtBytes(d.db.total)} 到底是怎么分的。` +
      (untitledNote ? ` ${untitledNote}` : '')
    : d.fileBased
      ? `${esc(who)} 的会话正文就是 <b>${d.db.bodies?.count || 0}</b> 个正文文件，` +
        `共 ${bytesB(d.db.bodies?.bytes || 0)}；本机没有会话数据库。` +
        `读到 <b>${d.totals.count}</b> 个会话，清理时正文文件会一并移入废纸篓。` +
        (purgeNote ? ` ${purgeNote}` : '')
      : d.db.bodies
        ? `${esc(who)} 的会话分两处存：索引库 ${bytesB(d.db.total)}，` +
          `正文文件 ${bytesB(d.db.bodies.bytes)}（<b>${d.db.bodies.count}</b> 个 rollout 文件）。` +
          `读到 <b>${d.totals.count}</b> 个会话。`
        : `会话库 ${bytesB(d.db.total)}，装着 <b>${d.totals.count}</b> 个会话、` +
          `${bytesB(text)} 的正文。` +
          (del
            ? `其中 <b>${del.count}</b> 个已在界面上删除，仍占 ${bytesB(del.bytes)}。`
            : '');
}

/** 动手之前的前提条。分支由后端的能力标记决定，不在前端猜；
 *  后端报的读取问题（库打不开、文件缺失）必须跟在后面上屏 ——
 *  静默会让人以为"这里本来就是空的"。返回 { className, html }。 */
export function taskWarnHtml(d) {
  const who = d.appLabel;
  let className = 'app-warn';
  let html;
  if (d.readOnly) {
    // 只读的理由由适配器给，前端不按 app 名硬编码。
    html = `${icon('key')}<div><b>${esc(who)} 的会话只读</b>：${esc(d.readOnlyNote || '这个工具的会话数据不提供写路径。')}</div>`;
  } else if (d.fileBased) {
    className = 'app-warn is-ok';
    html = fileBasedNote(d);
  } else if (d.app.unknown) {
    html = `${icon('alert')}<div>无法确认 ${esc(who)} 是否退出，暂不能写入数据库。${esc(d.app.error || '')}</div>`;
  } else if (d.app.running) {
    html =
      `${icon('alert')}<div><b>${esc(who)} 正在运行</b>（${d.app.hits.map((h) => `${esc(h.name)} ×${h.pids}`).join('、')}）。` +
      `清理需要往会话库里写数据，必须先<b>完全退出 ${esc(who)}</b>，否则可能损坏数据库。` +
      `下面可以正常浏览和勾选，只是删除按钮会被拒。</div>`;
  } else {
    className = 'app-warn is-ok';
    html = `${icon('box')}<div>${esc(who)} 没在运行，可以安全清理。动手前会自动把库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。</div>`;
  }
  if (d.problems?.length) {
    className = 'app-warn';
    html += `<br>${d.problems.map((p) => esc(p)).join('<br>')}`;
  }
  return { className, html };
}

/** 面板为空时的说明条：正文即文件的工具要交代"为什么这里没有可勾的东西"
 *  （否则人会以为文件清单里那堆 .jsonl 失踪了）；后端报的读取问题也要上屏，
 *  "库打不开"与"库是空的"必须能分清。无可说时返回 null。 */
export function taskEmptyWarnHtml(d) {
  const notes = [];
  if (d?.fileBased) notes.push(fileBasedNote(d));
  if (d?.problems?.length) {
    notes.push(`${icon('alert')}<div>${d.problems.map((p) => esc(p)).join('<br>')}</div>`);
  }
  if (!notes.length) return null;
  return { className: d.problems?.length ? 'app-warn' : 'app-warn is-ok', html: notes.join('<br>') };
}

/** 首屏「一键清理」的三段文案。跳过计数折进行内 —— 它说的就是
 *  "上面那两个开关挡掉了什么"；"删除只是打标记"的解释挪进大数字的
 *  tooltip（第一次见这个状态的人才需要，且悬停够了）。 */
export function taskQuickTexts(d, s, tq) {
  const skips = [];
  if (s.skippedRecent) skips.push(`${s.skippedRecent} 个近期还在用的`);
  if (tq.skipPinned && s.skippedPinned) skips.push(`${s.skippedPinned} 个置顶的`);
  return {
    subHtml:
      `勾选 <b>${s.tasks.length}</b> 个，共 ${fmtBytes(s.bytes)}` +
      (skips.length ? ` <span class="rec-off">（已跳过 ${skips.join('、')}）</span>` : ''),
    figureTitle:
      `${fmtBytes(s.bytes)}（${bytesTip(s.bytes)}）—— ${esc(d.appLabel)} 里"已删除"会话的正文总量。` +
      `它的删除只是打标记，正文一行没少，所以这里清的是仍占着的空间。`,
    btnTitle: s.tasks.length
      ? `勾选 ${s.tasks.length} 个会话，先摊开确认清单，不会立刻删除`
      : '按上面的范围一个都不剩，放宽"跳过最近"再试',
  };
}

/* ── 会话清理抽屉的文案 ───────────────────────────────────── */

/** 抽屉头上的读数。exTotal / exPending 由调用方算好传入 ——
 *  说明文字与读数要用同一份连带数字，各算各的迟早对不上。 */
export function taskDrawerStatsHtml({ count, rows, bytes, exTotal, exPending, exFailed, hasBodies }) {
  if (hasBodies) {
    return `<div class="dstat"><span>会话</span><b>${count.toLocaleString()}</b></div>
       <div class="dstat"><span>库里的条目</span><b>${rows.toLocaleString()}</b></div>
       <div class="dstat"><span>正文文件合计</span><b>${fmtBytes(bytes)}</b></div>`;
  }
  return `<div class="dstat"><span>会话</span><b>${count.toLocaleString()}</b></div>
       <div class="dstat"><span>正文合计</span><b>${fmtBytes(bytes)}</b></div>` +
    (exTotal && exTotal.bytes > 0
      ? `<div class="dstat"><span>连带回收</span><b>${fmtBytes(exTotal.bytes)}</b></div>
         <div class="dstat"><span>预计共回收</span><b>${fmtBytes(bytes + exTotal.bytes)}</b></div>`
      : exPending
        ? `<div class="dstat"><span>连带回收</span><b class="dstat-pending">正在算…</b></div>`
        : exFailed ? '<div class="dstat"><span>连带回收</span><b class="dstat-pending">未能估算，请先空跑</b></div>' : '');
}

/** 抽屉的说明。Cursor 两点不同：
 *  ① 它只写 state.vscdb —— conversation-search.db 是搜索索引，这里不碰，
 *     把两个库都写成"会从里面移除"是在暗示一件不会发生的事；
 *  ② 回收量有一大半来自"连带删掉的工具结果 blob"，不说清楚数字会显得虚高。 */
export function taskDrawerNoteHtml(d, { exB = 0, exN = 0, cascade = null }) {
  const who = d.appLabel;
  // 会写到哪几个库，由后端报的路径决定 —— 各工具不一样，前端不硬编码文件名
  const dbsTxt = (d.db.dbs || []).map((x) => `<code>${esc(shortPath(x.path))}</code>`).join(' 和 ');
  const backupTxt = `动手前会把库完整备份到 <code>${esc(shortPath(d.backupDir))}</code>。`;
  const cursorDbsTxt = (d.db.dbs || []).filter((x) => x.role !== 'index')
    .map((x) => `<code>${esc(shortPath(x.path))}</code>`).join(' 和 ');
  const cursorTxt = exB > 0
    ? `另外，这些会话还独占着 <b>${exN.toLocaleString()}</b> 个工具结果 blob（共 <b>${fmtBytes(exB)}</b>）—— ` +
      `只被它们引用的会一起删掉；仍被其它会话引用的会保留。`
    : `另：只被这些会话引用的工具结果 blob 会一起删掉，共享的保留。`;

  /* 级联之后，会话在磁盘上的专属文件（rollout 正文、贴图、transcript、
     命令日志、投影）也随这次删除一起走。以前它们会留下变孤儿 ——
     抽屉里原本写的是"文件要去文件清单再清一遍"，那句现在过时了。
     数字用**实际将要删的**清单算，不是估算。 */
  const fileTxt = cascade && cascade.count
    ? `另有 <b>${cascade.count.toLocaleString()}</b> 个会话文件（共 <b>${fmtBytes(cascade.bytes)}</b>）` +
      `会一起移入废纸篓；这些文件同样会先备份。`
    : '';

  return d.app.running
    ? `<b>${esc(who)} 仍在运行</b>，现在不能删除。请完全退出 ${esc(who)} 后重新打开本页。`
    : d.history === 'cursor-db'
      ? `删除会把这些会话的行从 ${cursorDbsTxt} 里彻底移除，` +
        `随后 <code>VACUUM</code> 重建数据库把空间真正交还给磁盘。${backupTxt}${cursorTxt}${fileTxt}`
      : `删除会把这些会话的行从 ${dbsTxt} 里彻底移除，` +
        `随后 <code>VACUUM</code> 重建数据库把空间真正交还给磁盘。${backupTxt}${fileTxt}` +
        // 正文在库外的工具（Codex 的 rollout、Claude/DSH 的正文文件）：
        // 有了级联之后它们会被一并带走，但"库回收量"这个数字仍然只算库。
        (fileTxt
          ? `「回收」那个数字只算数据库收缩的部分，不含上面这些文件。`
          : `<b>正文合计只是下限</b> —— 实际回收通常更多，因为索引也会一起收缩。`);
}

/** 抽屉里的待删清单。前缀用这一屏的 who，不用行上的字段 ——
 *  会话行上没有 appLabel，取不到就印出 "undefined，标题"。 */
export function taskDrawerListHtml(picked, who) {
  const sorted = picked.slice().sort((a, b) => b.bytes - a.bytes);
  return sorted.slice(0, 200).map((t) =>
    `<li title="${esc(t.title)}"><span>${esc(who)}，${esc(t.title)}</span><span>${fmtBytes(t.bytes)}</span></li>`).join('')
    + (sorted.length > 200 ? `<li><span>…还有 ${(sorted.length - 200).toLocaleString()} 个</span><span></span></li>` : '');
}
