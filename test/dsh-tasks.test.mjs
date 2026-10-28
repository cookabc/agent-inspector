/**
 * DeepSeek Harness 的会话读取。
 *
 * 它和别家最不一样的两点，正好也是最容易坏的两点：
 *
 *   ① 元数据在未压缩的投影缓存里，不在正文里 —— 所以正常情况下**不需要解压**。
 *      但投影可能缺（会话建了、没在界面上渲染过），那时必须回落到解压正文，
 *      而且只读开头一段。
 *   ② 一个会话是一个目录。删了正文，那个空的 session.lock 会留下 ——
 *      这件事必须在界面上说清楚，否则人会以为"删了还在"。
 *
 * 这些测试都在临时 HOME 下跑，绝不碰真实的 ~/.dsh。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanTasks } from '../lib/tasks-dsh.mjs';
import dshApp, { sessionIdOf } from '../lib/apps/dsh.mjs';

const classify = dshApp.classify;

const WS = '/tmp/agent-inspector-ws-test';
const SLUG = '--tmp-agent-inspector-ws-test--';

/**
 * 能不能造出真的 zstd 数据。
 *
 * `zlib.zstdCompressSync` 要到 Node 22.15 / 23.8 才有，而 CI 矩阵里有 22.5 ——
 * 那一档造不出夹具。这不是产品代码的问题（读取侧有 null 守卫，退化路径本身
 * 在最后一条测试里单独验），所以这里跳过而不是让夹具的短板把测试染红。
 */
const CAN_ZSTD = typeof zlib.zstdCompressSync === 'function';

/** 造一个 ~/.dsh。spec.sessions 里的每一项要么给 projection，要么给 events。 */
async function makeRoot(t, spec = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-dsh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(path.join(root, 'sessions', SLUG), { recursive: true });
  await fs.mkdir(path.join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true });

  for (const s of spec.sessions || []) {
    const dir = path.join(root, 'sessions', SLUG, s.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'session.lock'), '');
    const body = s.events
      ? zlib.zstdCompressSync(Buffer.from(
        s.events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'))
      : Buffer.alloc(s.bodyBytes ?? 256, 0x7a);
    await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), body);

    if (s.projection !== false) {
      await fs.writeFile(
        path.join(root, 'storages', 'session_projcache', 'sessions', `${s.id}.json`),
        JSON.stringify({ version: 7, record: { identity: s.identity || {}, rows: s.projection || {} } }),
      );
    }
  }

  if (spec.workspace !== null) {
    await fs.writeFile(path.join(root, 'storages', 'workspace.json'), JSON.stringify(spec.workspace || {
      global: { workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { w1: { path: WS, title: 'ws', sessionIds: (spec.sessions || []).map((s) => s.id) } } },
    }));
  }
  return root;
}

const proj = (title, extra = {}) => ({
  title: { ver: 1, seq: 1, val: title },
  sessionStats: { ver: 1, seq: 1, val: { steps: 3 } },
  modelSelection: { ver: 1, seq: 1, val: { lastUsed: { provider: 'magpie', model: 'deepseek-v4.1-flash' } } },
  ...extra,
});

/* ── 主路径：投影缓存 ─────────────────────────────────────── */

test('标题、cwd、步数、模型全部来自投影缓存，不解压正文', async (t) => {
  const id = 'session-aaaa0000-0000-0000-0000-000000000001';
  const root = await makeRoot(t, {
    sessions: [{
      id,
      // 正文故意写成**不是**合法 zstd：只要它被解压，测试就会失败
      events: null,
      bodyBytes: 4096,
      identity: { createdAt: 1790000000000, cwd: WS },
      projection: proj('投影里的标题'),
    }],
  });
  // 覆盖掉那个占位正文，放一段垃圾进去
  await fs.writeFile(path.join(root, 'sessions', SLUG, id, 'session.v4.jsonl.zstd'), Buffer.alloc(4096, 0xff));

  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);

  assert.ok(row, '有正文文件的会话必须列出来');
  assert.equal(row.title, '投影里的标题');
  assert.equal(row.workspace, WS);
  assert.equal(row.rows, 3, '步数取自 sessionStats.steps');
  assert.equal(row.model, 'magpie / deepseek-v4.1-flash');
  assert.equal(row.bytes, 4096);
  // 投影路径不该产生"解压失败"这类问题
  assert.equal(d.problems.length, 0, `不该有问题：${d.problems.join('；')}`);
});

test('有投影时完全不碰正文 —— 连 zstd 都不需要', async (t) => {
  /* 这是整个模块的设计前提：列表只需要元数据，而元数据在未压缩的投影里。
     验证方式是让正文**不存在**：只要读取路径碰了它，这里就会出问题
     （体积会变 0、标题会退回 id、problems 会多一条解压失败）。
     老 Node 上没有 zstd 也能读到标题，靠的就是这一条。 */
  const id = 'session-bbbb1111-0000-0000-0000-0000000000b1';
  const root = await makeRoot(t, {
    sessions: [{
      id,
      projection: proj('只靠投影'),
      identity: { createdAt: 1790000000000, cwd: os.tmpdir() },
      bodyBytes: 2048,
    }],
  });

  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.equal(row.title, '只靠投影');
  assert.equal(row.bytes, 2048);
  assert.deepEqual(d.problems, [], `投影齐全时不该报任何问题：${JSON.stringify(d.problems)}`);
});

test('模型名把 provider 与 model 拼起来，缺一个就不硬拼分隔符', async (t) => {
  const a = 'session-aaaa0000-0000-0000-0000-00000000000a';
  const b = 'session-bbbb0000-0000-0000-0000-00000000000b';
  const root = await makeRoot(t, {
    sessions: [
      { id: a, projection: proj('只有 model', { modelSelection: { ver: 1, seq: 1, val: { lastUsed: { model: 'm1' } } } }) },
      { id: b, projection: proj('没有 model', { modelSelection: { ver: 1, seq: 1, val: {} } }) },
    ],
  });
  const d = await scanTasks(root);
  assert.equal(d.tasks.find((x) => x.id === a).model, 'm1');
  assert.equal(d.tasks.find((x) => x.id === b).model, '');
});

/* ── 兜底：投影缺失时解压 ─────────────────────────────────── */

test('投影缺失时解压正文取标题，且只认用户自己发的那条', async (t) => {
  if (!CAN_ZSTD) return t.skip('这台 Node 没有 zstdCompressSync，造不出夹具');
  const id = 'session-cccc0000-0000-0000-0000-00000000000c';
  const root = await makeRoot(t, {
    sessions: [{
      id,
      projection: false,
      events: [
        { type: 'session', version: 4, id, createdAt: 1790000000000, cwd: WS, agentPreset: 'standard' },
        // 这条是系统注入的通知，不是用户提问 —— 不能拿它当标题
        { type: 'user/message', data: { content: [{ type: 'text', text: '权限策略已变更' }], source: { kind: 'user-approval' } } },
        { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看下这个表' }], source: { kind: 'user' } } },
      ],
    }],
  });

  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.ok(row);
  assert.equal(row.title, '帮我看下这个表');
  assert.equal(row.workspace, WS, 'cwd 来自第一行 session 事件');
  assert.equal(row.createdAt, 1790000000000);
});

test('session/title 覆盖先前的兜底标题（改名后要以最后一条为准）', async (t) => {
  if (!CAN_ZSTD) return t.skip('这台 Node 没有 zstdCompressSync，造不出夹具');
  const id = 'session-dddd0000-0000-0000-0000-00000000000d';
  const root = await makeRoot(t, {
    sessions: [{
      id,
      projection: false,
      events: [
        { type: 'session', version: 4, id, createdAt: 1, cwd: WS },
        { type: 'user/message', data: { content: [{ type: 'text', text: '原始提问' }], source: { kind: 'user' } } },
        { type: 'session/title', data: { title: '旧标题', source: { kind: 'fallback' } } },
        { type: 'session/title', data: { title: '改过的标题', source: { kind: 'provider' } } },
      ],
    }],
  });
  const d = await scanTasks(root);
  assert.equal(d.tasks.find((x) => x.id === id).title, '改过的标题');
});

test('正文不是合法 zstd 时不清空会话，只是没有标题', async (t) => {
  const id = 'session-eeee0000-0000-0000-0000-00000000000e';
  const root = await makeRoot(t, { sessions: [{ id, projection: false, bodyBytes: 300 }] });
  await fs.writeFile(path.join(root, 'sessions', SLUG, id, 'session.v4.jsonl.zstd'), Buffer.alloc(300, 0x11));

  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.ok(row, '解不开正文不等于会话不存在');
  assert.equal(row.bytes, 300, '体积照旧从 stat 来');
  assert.match(row.title, new RegExp(id), '没有标题时退回 id，不编造');
  // 缺标题这件事要说出来，不能让人以为工具读坏了
  assert.ok(
    d.problems.some((p) => p.includes('没有投影缓存')),
    `缺标题必须报出来：${JSON.stringify(d.problems)}`,
  );
});

test('没有投影时不能静默 —— 老 Node 上要说明是 zstd 不可用', async (t) => {
  /* 这条要在两种 Node 上都跑：有 zstd 时说"从正文解压"，没有时说
     "当前 Node 没有内置 zstd"。判据本身不依赖压缩能力，所以不 skip。 */
  if (!CAN_ZSTD) {
    // 造不出合法 zstd 也无所谓 —— 这条测的是"缺标题要报出来"，不是能不能解开
  }
  /* CI 在 Node 22.5 上跑，而 zlib.zstdDecompressSync 要到 22.15 / 23.8 才有。
     那条路径下会话照样列出、体积照样算，只是没有标题 —— 必须明说原因，
     否则看起来像"这个工具读不出标题"。 */
  const id = 'session-aaaa1111-0000-0000-0000-0000000000a1';
  const root = await makeRoot(t, {
    sessions: [{
      id,
      projection: false,
      // 没有 zstd 时给一段垃圾正文：这条测的是"缺标题要报出来"，
      // 解不解得开不影响判据（两种 Node 上都要能过）。
      ...(CAN_ZSTD
        ? { events: [
          { type: 'session', version: 4, id, createdAt: 1, cwd: os.tmpdir() },
          { type: 'user/message', data: { content: [{ type: 'text', text: '问一句' }], source: { kind: 'user' } } },
        ] }
        : { bodyBytes: 128 }),
    }],
  });
  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.ok(row, '没有投影也要列出来');
  const note = d.problems.find((p) => p.includes('没有投影缓存'));
  assert.ok(note, `要报出缺投影：${JSON.stringify(d.problems)}`);
  // 有 zstd 时说"从正文解压"，没有时说"当前 Node 没有内置 zstd"
  const hasZstd = typeof (await import('node:zlib')).zstdDecompressSync === 'function';
  assert.match(note, hasZstd ? /从正文开头解压/ : /没有内置 zstd 解压/);
});

/* ── 状态与原因 ───────────────────────────────────────────── */

test('归档与置顶来自 workspace.json，不来自投影', async (t) => {
  const arch = 'session-11110000-0000-0000-0000-000000000011';
  const pin = 'session-22220000-0000-0000-0000-000000000022';
  // 工作区路径必须真实存在：不存在的话两条都会先被标成 wsMissing，
  // 那就测不到"置顶的活跃会话不该可清"这件事了。
  const root = await makeRoot(t, {
    sessions: [
      { id: arch, projection: proj('归档的') },
      { id: pin, projection: proj('置顶的') },
    ],
    workspace: {
      global: { archivedSessionIds: [arch], pinnedSessionIds: [pin] },
      tables: { workspaces: { w1: { path: os.tmpdir(), sessionIds: [arch, pin] } } },
    },
  });

  const d = await scanTasks(root);
  const a = d.tasks.find((x) => x.id === arch);
  const p = d.tasks.find((x) => x.id === pin);

  assert.equal(a.state, 'archived');
  assert.equal(a.reason, 'archived', '归档的可以清');
  assert.equal(p.pinned, true);
  assert.equal(p.state, 'active');
  /* 活跃会话也是可清的（reason='manual'），与 Cursor 同一条理由：
     Harness 的一个会话就是一个自包含目录，删掉不留悬空引用。
     置顶只影响"一键清理"的默认范围，不影响能不能手动勾。 */
  assert.equal(p.reason, 'manual');
});

test('活跃会话也允许手动清理 —— 一个会话就是一个自包含目录', async (t) => {
  /* 与 Claude Code 的关键差别。Claude 那边 reason 为 null 就选不中：
     它的 .jsonl 是唯一的正文，删活跃会话会让索引指向不存在的文件。
     Harness 删一个会话目录不留任何悬空引用，所以"用户勾了它"本身就是依据。 */
  const id = 'session-88880000-0000-0000-0000-000000000088';
  const root = await makeRoot(t, {
    sessions: [{ id, projection: proj('活跃但可清') }],
    workspace: { global: {}, tables: { workspaces: { w1: { path: os.tmpdir(), sessionIds: [id] } } } },
  });
  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.equal(row.state, 'active');
  assert.equal(row.reason, 'manual');
});

test('工作区路径不存在时标 wsMissing', async (t) => {
  const id = 'session-33330000-0000-0000-0000-000000000033';
  const root = await makeRoot(t, {
    sessions: [{ id, projection: proj('工作区没了') }],
    workspace: {
      global: {},
      tables: { workspaces: { w1: { path: '/definitely/not/here/agent-inspector', sessionIds: [id] } } },
    },
  });
  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.equal(row.reason, 'wsMissing');
  assert.equal(row.state, 'active', 'state 与 reason 是两个轴：它仍然是活跃会话');
});

test('workspace.json 读不到时所有会话按活跃处理，不猜', async (t) => {
  const id = 'session-44440000-0000-0000-0000-000000000044';
  const root = await makeRoot(t, {
    sessions: [{ id, projection: proj('索引坏了') }],
    workspace: null,   // 完全不写这个文件
  });
  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.equal(row.state, 'active');
  assert.equal(row.pinned, false);
  assert.equal(row.reason, 'manual', '判不了归档就别乱标，但仍允许手动清理');
  // 文件不存在不算问题（Harness 还没初始化过）；但列表必须照常出来
  assert.equal(row.title, '索引坏了');
});

/* ── 目录形状 ─────────────────────────────────────────────── */

test('只剩 session.lock 的目录不列成会话，但要在 problems 里交代', async (t) => {
  const live = 'session-55550000-0000-0000-0000-000000000055';
  const dead = 'session-66660000-0000-0000-0000-000000000066';
  const root = await makeRoot(t, { sessions: [{ id: live, projection: proj('还在的') }] });

  // 手动造一个"正文已删、锁还在"的目录
  const dir = path.join(root, 'sessions', SLUG, dead);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'session.lock'), '');

  const d = await scanTasks(root);
  assert.equal(d.tasks.length, 1, '只剩锁的目录不该画成一条会话');
  assert.ok(d.tasks.every((x) => x.id !== dead));
  assert.ok(
    d.problems.some((p) => p.includes('session.lock')),
    `必须在 problems 里说明那堆空锁去哪了：${JSON.stringify(d.problems)}`,
  );
});

test('没有 sessions/ 时给空表 + 一句人话', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-inspector-dsh-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const d = await scanTasks(root);
  assert.deepEqual(d.tasks, []);
  assert.equal(d.totals.count, 0);
  assert.equal(d.db.total, 0);
  assert.deepEqual(d.db.dbs, [], '没有会话库，dbs 是空数组而不是 undefined');
  assert.ok(d.problems.some((p) => p.includes('sessions/')), '缺目录要说出来');
});

test('bodyRel 从扫描根起算，且正文只归会话管理、不进文件清单', async (t) => {
  /* bodyRel 若相对 sessions/ 拼，而根是 ~/.dsh，就差一层 —— 那是拼错。
     但"能在文件清单里找到"这条旧判据已经过时：会话正文现在整体移出清单，
     归会话管理。所以判据换成两条，一起证明"路径对得上、归属也对"：
       1. bodyRel 与真实文件路径一致（用真扫描交叉验证，不只比字符串）
       2. 它不出现在文件清单里，但出现在该会话的「所属内容」里 */
  const id = 'session-99990000-0000-0000-0000-000000000099';
  const root = await makeRoot(t, { sessions: [{ id, projection: proj('路径要对上') }] });

  const d = await scanTasks(root);
  const row = d.tasks.find((x) => x.id === id);
  assert.equal(
    row.bodyRel,
    `sessions/${SLUG}/${id}/session.v4.jsonl.zstd`,
    'bodyRel 必须从 ~/.dsh 起算',
  );

  const dshAppMod = (await import('../lib/apps/dsh.mjs')).default;
  const { scanTarget } = await import('../lib/scan.mjs');
  const scan = await scanTarget(dshAppMod, { key: 'root', kind: 'dir', path: root });
  assert.ok(
    !scan.files.some((f) => f.p === row.bodyRel),
    `会话正文不该出现在文件清单里：${row.bodyRel}`,
  );

  /* contents 由**路由器**挂上（lib/tasks.mjs 的 scanTasks），
     适配器自己那份 scanTasks 只管读、不负责归属。所以要验「所属内容」
     必须走路由器 —— 这正是界面上真正用的那条路径。 */
  const { scanTasks: scanViaRouter } = await import('../lib/tasks.mjs');
  const routed = await scanViaRouter(dshAppMod, [{ key: 'root', kind: 'dir', path: root }]);
  const routedRow = routed.tasks.find((x) => x.id === id);
  assert.ok(
    (routedRow?.contents?.files || []).some((f) => f.role === 'body'),
    '会话的「所属内容」要把它列出来 —— 否则它既不在清单里也没人负责',
  );
});

test('db.bodies 的分母只算正文文件，不含锁', async (t) => {
  const id = 'session-77770000-0000-0000-0000-000000000077';
  const root = await makeRoot(t, { sessions: [{ id, projection: proj('x'), bodyBytes: 1000 }] });
  const d = await scanTasks(root);
  assert.equal(d.db.bodies.count, 1);
  assert.equal(d.db.bodies.bytes, 1000);
  assert.equal(d.db.total, 0, '没有会话库，库体积为 0 而不是 undefined');
});

/* ── 分类与 id 提取 ───────────────────────────────────────── */

test('分类规则：正文、锁、投影、索引、凭据各归各位', () => {
  const rel = `sessions/${SLUG}/session-abc/session.v4.jsonl.zstd`;
  assert.equal(classify(rel, 10, {}), 'transcript');
  assert.equal(classify(`sessions/${SLUG}/session-abc/session.lock`, 0, {}), 'sessionLock');
  assert.equal(classify('storages/session_projcache/sessions/x.json', 10, {}), 'projectionCache');
  assert.equal(classify('storages/workspace.json', 10, {}), 'workspaceIndex');
  assert.equal(classify('profiles/web/cordis.yml', 10, {}), 'profileConfig');
  assert.equal(classify('.credentials.yaml', 10, {}), 'credentials');
  assert.equal(classify('.env', 10, {}), 'credentials');
  assert.equal(classify('config.yaml', 10, {}), 'appConfig');
  assert.equal(classify('whatever.bin', 10, {}), 'unknown');
});

test('备份目录先于所有规则：backups/ 里的库是副本，不是真库', () => {
  // 与其余各家同一条共享规则、同一个位置 —— 顺序错了这里就会红
  assert.equal(classify('backups/state.sqlite', 10, {}), 'dataBackup');
  assert.equal(classify('backups/2026/10/x.json', 10, {}), 'dataBackup');
  assert.equal(classify('config.yaml.bak', 10, {}), 'configBackup');
});

test('sessionIdOf 从目录形状里取，取不到返回 null', () => {
  assert.equal(sessionIdOf(`sessions/${SLUG}/session-abc/session.v4.jsonl.zstd`), 'session-abc');
  assert.equal(sessionIdOf(`sessions/${SLUG}/session-abc/session.lock`), 'session-abc');
  assert.equal(sessionIdOf('storages/workspace.json'), null);
  assert.equal(sessionIdOf(''), null);
});
