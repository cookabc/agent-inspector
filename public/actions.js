/**
 * 点击动作的纯逻辑层。
 *
 * 起因是 app.js 里那个 260 行、35 个分支的 click 处理器 —— 它是整个前端
 * 最难读、最容易改坏的地方。拆开之后这里放的是**决定"点了要改哪些状态"**
 * 的部分，不带任何 DOM 操作与渲染调用，所以可以直接拿夹具断言。
 *
 * 约定：每个 action 接收 (state, 参数)，返回
 *   { changed }   是否改动了状态（false = 这次点击不该重画）
 * 或
 *   { changed, side: [...] }  需要调用方额外做的事（渲染、滚动、异步）
 *
 * 渲染与副作用留在 app.js —— 这里只管"状态怎么变"。
 * 好处是那些最难检查的逻辑（比如"三块分组只勾当前筛出来的"）终于能被
 * 单测钉住，而不必用假 DOM 跑一遍。
 */

/* ── 三块分组：整组勾上 / 取消 ────────────────────────────── */

/**
 * 点三块之一。
 *
 * 三条规矩：
 *   ① 只勾**当前筛选下看得见的**那些。块上写着"筛出 N / 一共 M"，
 *      点一下却把 M 全勾上，那是在偷偷扩大范围。
 *   ② 受保护内容与软链接都不进选区（判据由调用方注入，只有一份）。
 *   ③ 三块互斥：它们把全部文件劈成三份，所以换一组是"换成它"，
 *      不是"再加上它" —— 必须先清空。
 *
 * @param {object} state 需要 selection / group
 * @param {string} g     分组键（orphan / live / other）
 * @param {{files: Array, groupOf: Function, canPick: Function, matches: Function, keyOf: Function}} deps
 * @returns {{changed: boolean, allWasOn: boolean}}
 */
export function toggleSplitGroup(state, g, deps) {
  const { files, groupOf, canPick, matches, keyOf } = deps;
  // matches 读取当前分组；切换时先应用新分组，仍保留搜索与状态筛选。
  state.group = g;
  const mine = files.filter((f) => groupOf(f) === g && canPick(f) && matches(f));
  const allOn = mine.length > 0 && mine.every((f) => state.selection.has(keyOf(f)));

  state.selection.clear();
  if (allOn) {
    state.group = null;            // 再点一下 = 整组取消
  } else {
    for (const f of mine) state.selection.add(keyOf(f));
    state.group = g;
  }
  return { changed: true, allWasOn: allOn };
}

/* ── 全选 / 取消 / 推荐清理 ───────────────────────────────── */

/**
 * 「全选可见」：勾上当前筛选后看得见的所有可清项。
 *
 * 不先清空 —— 全选的语义是"补满"，用户可能已经单独勾了几项。
 */
export function selectAllVisible(state, groups, deps) {
  const { selectableOnly, keyOf } = deps;
  let added = 0;
  for (const { cat, files } of groups) {
    for (const f of selectableOnly(files, cat)) {
      if (!state.selection.has(keyOf(f))) added += 1;
      state.selection.add(keyOf(f));
    }
  }
  return { changed: added > 0, added };
}

/** 「取消」：清空选区，并把分组筛选一起撤掉。
 *  只清选区不清筛选的话，清单还筛着、三块却全是没勾的样子 —— 两处说的不是一回事。 */
export function clearSelection(state) {
  const had = state.selection.size > 0 || state.group !== null;
  state.selection.clear();
  state.group = null;
  return { changed: had };
}

/**
 * 「推荐清理」：清掉筛选，勾满当前推荐范围，然后开确认抽屉。
 *
 * 为什么先清筛选：勾中的东西如果被搜索/分组筛掉了，用户看不见自己勾了什么，
 * 而下一步就要确认删除 —— 看不见的选区不该被删。
 *
 * 为什么逐个过 selectableOnly：推荐分类里也可能混着软链接（插件缓存里的
 * .bin、app-server 的旧版本可执行文件都是）。带上它们 → 服务端拒绝整批 →
 * 一个都删不掉。
 */
export function selectRecommended(state, cats, deps) {
  const { filesOf, selectableOnly, keyOf } = deps;
  state.q = '';
  state.statuses.clear();
  state.group = null;
  state.selection.clear();
  for (const c of cats) {
    for (const f of selectableOnly(filesOf(c.id), c)) state.selection.add(keyOf(f));
  }
  return { changed: true, count: state.selection.size };
}

/* ── 分组卡复选框 ─────────────────────────────────────────── */

/**
 * 点一张分类卡头上的复选框：勾上/取消这一卡里**当前可见且可清**的行。
 *
 * 只动可见行，与卡片头上那个框自己的状态对得上。顺带把卡片展开 ——
 * 勾上一整卡却看不见里面有什么，下一步就是确认删除。
 */
export function toggleGroupBox(state, catId, checked, deps) {
  const { filesOf, matches, selectableOnly, catOf, keyOf } = deps;
  const cat = catOf(catId);
  let n = 0;
  for (const f of selectableOnly(filesOf(catId).filter(matches), cat)) {
    checked ? state.selection.add(keyOf(f)) : state.selection.delete(keyOf(f));
    n += 1;
  }
  state.open.add(catId);
  return { changed: true, count: n };
}

/* ── 单行复选框 ───────────────────────────────────────────── */

/**
 * 单行勾选。
 *
 * 注意这里**不复查判据**：这颗复选框在渲染时就已经按判据禁用了
 * （受保护项与软链接都是 disabled），用户点不到它。视图层的契约测试
 * 钉住了那个前提。
 */
export function toggleRow(state, key, checked) {
  if (checked) state.selection.add(key);
  else state.selection.delete(key);
  return { changed: true };
}

/* ── 会话分组整组勾选 ─────────────────────────────────────── */

/**
 * 点一个工作区分组头上的复选框：把这一组里**能清的那些**整组勾上或取消。
 *
 * 与文件侧的 groupBox 同一条规矩，判据由调用方注入、只有一份：
 *   ① 只动传进来的这批 —— 它们已经是 visibleTasks 筛过 + 按工作区分好的，
 *      所以"只勾当前看得见的"天然成立，不会偷偷扩到别的组或筛掉的行。
 *   ② canPick 为假（reason 为空、当前不可清）的行不进选区 —— 选了服务端也会拒，
 *      白选；组上那句"已选 N"也就对不上实际会删的条数了。
 *   ③ checked 是复选框**点完之后**的状态（true=要全勾，false=要全撤），
 *      所以不需要"是否已经全选"的嗅探，交给原生三态。
 *
 * state 这里传的是 taskState（用它的 sel），与文件清单的 state.selection
 * 是两套选区 —— 两条线各管各的勾选，从不同时亮。
 *
 * @param {{sel: Set}} state
 * @param {Array} tasks        这一组里的会话（可见、已分组）
 * @param {boolean} checked
 * @param {{canPick: Function, idOf: Function}} deps
 * @returns {{changed: boolean, count: number}}
 */
export function toggleTaskGroup(state, tasks, checked, deps) {
  const { canPick, idOf } = deps;
  let n = 0;
  for (const t of tasks) {
    if (!canPick(t)) continue;
    checked ? state.sel.add(idOf(t)) : state.sel.delete(idOf(t));
    n += 1;
  }
  return { changed: true, count: n };
}

/* ── 筛选 ─────────────────────────────────────────────────── */

/** 切一个状态档位的筛选（多选）。 */
export function toggleStatus(state, s) {
  state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
  return { changed: true };
}

/** 展开/收起一张分类卡的说明。 */
export function toggleExplain(state, catId) {
  state.explain.has(catId) ? state.explain.delete(catId) : state.explain.add(catId);
  return { changed: true };
}

/** 展开/收起一张分类卡的清单。 */
export function toggleCategory(state, catId) {
  state.open.has(catId) ? state.open.delete(catId) : state.open.add(catId);
  return { changed: true };
}

/* ── 推荐范围的单项开关 ───────────────────────────────────── */

export function toggleRecommendItem(state, catId) {
  state.recOff.has(catId) ? state.recOff.delete(catId) : state.recOff.add(catId);
  return { changed: true };
}

/* ── 「全部」视图 ─────────────────────────────────────────── */

/**
 * 折叠/展开「全部」里的一组。
 *
 * 默认展开前 defaultOpen 组，所以"当前是开还是关"不能只看 open 集合 ——
 * 得先判断这一组是不是落在默认展开的范围内。否则点第一组的收起，
 * 它会被"默认展开"的规则立刻翻回来，看起来像点了没反应。
 */
export function toggleAllGroup(allState, ws, groupIndex, defaultOpen) {
  const isOpen = allState.open.has(ws)
    || (groupIndex >= 0 && groupIndex < defaultOpen && !allState.collapsed.has(ws));
  if (isOpen) { allState.open.delete(ws); allState.collapsed.add(ws); }
  else { allState.collapsed.delete(ws); allState.open.add(ws); }
  return { changed: true, isOpen: !isOpen };
}

/** 切一个工具筛选（多选）。 */
export function toggleToolFilter(allState, appId) {
  allState.tools.has(appId) ? allState.tools.delete(appId) : allState.tools.add(appId);
  return { changed: true };
}

/* ── 主题 ─────────────────────────────────────────────────── */

/** 三态循环：跟随系统 → 深 → 浅 → 跟随系统。 */
export function nextTheme(current) {
  return current === 'dark' ? 'light' : current === 'light' ? '' : 'dark';
}
