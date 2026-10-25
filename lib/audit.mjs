/**
 * 凭据外泄审计的纯核心：只做判定，不碰任何 I/O。
 *
 * 被审计的模式来自真实事故的形状（Beacon 的演示里那次"生产库密码发给了
 * 模型商"就是同一类）：Agent 先读了凭据文件（.env、id_rsa、credentials…），
 * 稍后一条**外发**命令里出现了同一个值 —— curl 带着它、URL 里嵌着它、
 * 或者它直接被拼进了发给第三方的请求。
 *
 * 三级命中：
 *   high   secret-out      先读到、后外发 —— 同一个值在两处出现，时间顺序成立
 *   medium secret-inline   外发命令里内嵌疑似凭据（看不到前置读取也报，宁可多问一句）
 *   info   sensitive-read  读过敏感文件。文件内容本身已经进了模型上下文，
 *                          这不是"要删的东西"，是"该知道的事"
 *
 * 两条不变量，测试盯死：
 *   1. **证据里绝不出现密文原文**。这个工具自己是审计凭据的，结果把凭据
 *      摘出来摆在页面上，就成了新的泄露面。所有 evidence 出 core 前过
 *      done() 的终检：对 bank 里每一个值、对每条样式正则再扫一遍，
 *      撞上就再脱一次。脱敏失败不是"显示难看"，是事故。
 *   2. **判不出来就放行**在这里不成立 —— 这条线只读不删，漏报的代价是
 *      用户不知道；误报的代价是用户多点一眼。所以样式全部收窄（长度、
 *      字符集、上下文词），宁可少报也不制造噪音。
 */

/* ── 敏感路径 ─────────────────────────────────────────────── */

/* basename 级的样式。.example/.sample/.template 是样例文件，里面没有真凭据，
   不该混进 P3 的清单里。 */
const SENSITIVE_BASE = [
  /^\.env(\.[\w.-]+)?$/,
  /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.\d+)?$/,
  /^credentials(\.json)?$/i,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.htpasswd$/,
  /^service[-_]?account[\w.-]*\.json$/i,
  /^secrets?\.[\w.-]+$/i,
  /\.(pem|key)$/,
];
const SENSITIVE_SUFFIX_SKIP = /\.(example|sample|template|dist|orig|rej)$/i;
/** 目录级提示：路径里有这些段，整条路径按敏感算（basename 对不上的时候）。 */
const SENSITIVE_DIR = [/(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws\/credentials(\.|$)/, /(^|\/)\.docker\/config\.json$/];

export function isSensitivePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (/node_modules\//.test(p)) return false; // 库自带的测试证书/样例 key，读它是常规操作
  if (SENSITIVE_SUFFIX_SKIP.test(p)) return false;
  for (const re of SENSITIVE_DIR) if (re.test(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return SENSITIVE_BASE.some((re) => re.test(base));
}

/** 从一段命令文本里抠出"被提到的敏感路径"。cat / less / grep 不会自带结构化
 *  的 file_path，只能从文本里认 —— 认不出路径就漏一条 P3，不会误伤。 */
export function sensitivePathsIn(text) {
  if (!text) return [];
  const out = new Set();
  /* 带斜杠的路径（绝对、相对、~/ 三种都算）。
     绝对路径以 / 开头 —— 开头那个 / 必须由括号里的可选前缀吃掉，
     否则 `cat /Users/x/.env` 会因为"首字符不在字符类里"整条不匹配，
     而相对路径 `cat .env` 反而认得出来。这个不对称曾经真的漏了全部绝对路径。 */
  for (const m of text.matchAll(/(^|[\s"'=:,(])(~?\/?(?:[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.~@-]+)/g)) {
    if (isSensitivePath(m[2])) out.add(m[2]);
  }
  // 不带斜杠的裸文件名（cat .env / cat id_rsa）
  for (const m of text.matchAll(/(^|[\s"'=:,(])(\.env[\w.-]*|id_rsa[\w.-]*|id_ed25519[\w.-]*|credentials|\.npmrc|\.netrc|secrets?\.\w+)(?=$|[\s"'|;&)<])/g)) {
    out.add(m[2]);
  }
  return [...out];
}

/* ── 密文样式 ─────────────────────────────────────────────── */

/** 强样式：形状本身就是凭据，出现即算。长度与字符集都收得比较紧。 */
const TOKEN_PATTERNS = [
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: 'api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'stripe', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'slack', re: /\bxox[baposecr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];
/** URL 里带凭据：postgres://user:pass@host。Beacon 那次事故就是这一类。
 *  user 段可以为空（`redis://:pass@host` 是标准写法），所以用 {0,64}；
 *  但冒号必须有 —— 没有冒号就不是"账号:密码"结构，只是普通 URL。 */
const URL_CREDS = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s\/@:'"]{0,64}:[^@\s\/'"]{3,128}@[^\s\/'"]{1,255}/gi;
/** Bearer 后面的裸值：值本身未必匹配任何样式，但位置说明它是凭据。 */
const BEARER = /\b[Bb]earer\s+([A-Za-z0-9._+=/-]{16,})/g;
/** KV 赋值：password=… / "api_key": "…"。只用于**敏感文件内容或 env 倾倒**
 *  的入库 —— 拿它扫任意文本会把配置代码全点亮。
 *
 *  前缀不能用 `\b`，也不能用 `[^A-Za-z0-9_]` —— 两者都认不出 `DB_PASSWORD=`：
 *  下划线在正则里算单词字符，`\bPASSWORD` 在那儿不成立。而全大写下划线正是
 *  .env 与 env 表的标准形状，漏掉它等于这条规则在实际数据上一个都命中不了。
 *  所以前缀只排除"字母和数字"：允许 `_` 作前导，但 `xPASSWORD`（某个变量名的
 *  尾巴）仍然不算。
 */
const KV_SECRET = /(?:^|[^A-Za-z0-9])(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|db[_-]?url)\s*[=:]\s*["']?([^\s"'`,;]{8,})/gi;

const PLACEHOLDER = new Set([
  'changeme', 'changeit', 'password', 'passwords', 'secret', 'secrets', 'token', 'example',
  'placeholder', 'your_password', 'yourpassword', 'xxxxxxxx', 'xxxxxxx', '12345678', '123456789',
  'true', 'false', 'null', 'undefined', 'none', 'string', 'xxxx-xxxx-xxxx',
]);

export function scanTokens(text) {
  const out = [];
  if (!text) return out;
  for (const { kind, re } of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ value: m[0], kind });
  }
  for (const m of text.matchAll(URL_CREDS)) out.push({ value: m[0], kind: 'url-creds' });
  for (const m of text.matchAll(BEARER)) out.push({ value: m[1], kind: 'bearer' });
  return out;
}

export function kvSecretsIn(text) {
  const out = [];
  if (!text) return out;
  KV_SECRET.lastIndex = 0;
  for (const m of text.matchAll(KV_SECRET)) {
    const v = m[1];
    if (PLACEHOLDER.has(v.toLowerCase())) continue;
    // 键名只取关键字本身：整段匹配带着前导分隔符（`\n`、`_`、引号），
    // 直接拿来当展示用的样式名会印出 `_password` 这种东西。
    const hit = /(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|database[_-]?url|db[_-]?url)/i.exec(m[0]);
    out.push({ value: v, key: (hit ? hit[1] : '').toLowerCase() });
  }
  return out;
}

/** 外部目标（localhost 一族不算外发）。 */
export function externalUrlsIn(text) {
  if (!text) return [];
  const out = [];
  for (const m of text.matchAll(/https?:\/\/(?!localhost[:/]|\b127\.|\b0\.0\.0\.0\b|\[::1\]|host\.docker\.internal)([A-Za-z0-9.-]+)/g)) {
    out.push(m[1]);
  }
  return out;
}

const OUTBOUND_WORDS = /\b(curl|wget|nc|ncat|socat|ngrok|httpie|telnet|ftp|scp|sftp|rsync)\b/;
/** exec 沙箱里的 JS：外发长这样 —— 取 URL 的工具、fetch、http 客户端。 */
const OUTBOUND_JS = /\b(web__run|fetch|axios|undici|\.request\s*\(|https?\.request|got\s*\()/;

/**
 * 一条调用算不算"外发"。kind 决定判据：
 *   cmd   shell 命令 —— 外发动词，或命令里出现外部 URL
 *   code  JS 沙箱代码 —— 外部 URL、取网工具、fetch 族
 *   web   WebFetch / WebSearch —— 生来就是外发
 */
export function isOutbound(text, kind) {
  if (kind === 'web') return true;
  if (!text) return false;
  if (externalUrlsIn(text).length) return true;
  // 带凭据的连接串本身就是"把库地址+账号密码交给某个客户端"，sql/redis 客户端
  // 也会打到外部主机（psql postgres://…@prod-db）—— 与 curl 同性质
  if (kindsWithCredsIn(text)) return true;
  if (kind === 'cmd') return OUTBOUND_WORDS.test(text);
  if (kind === 'code') return OUTBOUND_JS.test(text);
  return false;
}

/** 文本里是否有"带账号密码的连接串"（任意 scheme）。
 *
 *  这条判据曾把整条审计拖死：原正则 `[a-z][a-z0-9+.-]*:\/\/…` 在长文本上
 *  退化成二次方回溯 —— 实测 200 KB 含一个 `://` 的文本要跑 21 秒。
 *  会话里命令输出几百 KB 是常态，所以这里改成"定位 + 只看局部"：
 *  每次 indexOf 找到 `://`，只回看紧邻的 65 个字符（scheme 与 user 段的
 *  合理上限），在那一小段上跑正则。复杂度与文本里 `://` 的个数线性相关。 */
const CREDS_IN_URL = /[a-z][a-z0-9+.-]{0,20}:\/\/[^\s\/@:'"]{1,64}:[^@\s\/'"]{3,64}@/i;
function kindsWithCredsIn(text) {
  let from = 0;
  while (true) {
    const at = text.indexOf('://', from);
    if (at < 0) return false;
    const start = Math.max(0, at - 24);       // scheme 名最长 21 + 余量
    // 窗口从 scheme 起点往后取 240 字符：scheme + :// + user + : + pass + @ 足够
    const window = text.slice(start, start + 24 + 3 + 220);
    if (CREDS_IN_URL.test(window)) return true;
    from = at + 3;
  }
}

/* ── 脱敏 ─────────────────────────────────────────────────── */

/**
 * 单个值脱敏。保留的头尾只够人认出"这是哪个凭据"（比如 sk-pr…x9），
 * 不够拿去用。按码点切，中文值也不会被切出半个字符。
 */
export function maskSecret(v) {
  const s = Array.from(String(v ?? ''));
  if (s.length <= 6) return '••••';
  if (s.length <= 10) return s[0] + '••••';
  return s.slice(0, 3).join('') + '••••' + s.slice(-2).join('');
}

const clipText = (s, n) => {
  const a = Array.from(s);
  return a.length <= n ? a.join('') : a.slice(0, n).join('') + '…';
};

/**
 * 证据 = 命中点附近的一小段窗口，其中所有已知密文全部脱敏。
 *
 * 先把整段文本里的每一个已知值（bank + 本段扫出的样式）替换成脱敏形，
 * 再取窗口 —— 顺序不能反：先取窗口再替换，窗口边界上的值会被截成
 * 两半，两半都不再匹配原文，等于原样漏出去半截。
 */
export function buildEvidence(text, values, at = 0) {
  if (!text) return '';
  let masked = String(text);
  const all = [...values, ...scanTokens(text).map((t) => t.value)];
  for (const v of all) {
    if (!v || v.length < 4) continue;
    masked = masked.split(v).join(maskSecret(v));
  }
  const flat = masked.replace(/\s+/g, ' ').trim();
  const W = 70;
  const start = Math.max(0, at - W);
  let out = flat.slice(start, start + W * 2 + 30);
  if (start > 0) out = '…' + out;
  if (start + out.length < flat.length) out += '…';
  return clipText(out, 200);
}

/* ── 扫描状态机 ───────────────────────────────────────────── */

/**
 * 单条文本参与正则扫描的上限。
 *
 * 正则再怎么写，长文本上的代价也不能完全指望它 —— 这条线里有一次实测：
 * 200 KB 的纯字母文本配上一条带 `+` 和 `:` 的正则跑了 27 秒，
 * 而会话里一条命令的输出常常就是几百 KB。宁可只看前 256 KB（凭据读取
 * 与外发都发生在开头——读完一个文件紧接着就是把它发出去），
 * 也不能让一次审计把服务卡死。
 *
 * 超出部分不参与**扫描**，但字节数照记（那才是"实际看了多少"）。
 */
const SCAN_WINDOW = 256 * 1024;

/**
 * 一个会话一个实例。按落盘顺序喂事件，结束时 done() 出结果。
 *
 * 事件：
 *   call {kind:'read', path}                 读文件（结构化 file_path）
 *   call {kind:'cmd'|'code', text, id?}      shell 命令 / 沙箱代码
 *   call {kind:'web', url, text?}            WebFetch / 搜索
 *   out  {id, text}                          上述调用（id 配对）的输出
 *
 * bank（已见过的凭据值）来源只有两种，都有明确出处，不扫任意文本：
 *   · 敏感路径的读取输出（Read .env 的内容、cat id_rsa 的回显）
 *   · env / printenv 的倾倒输出
 */
export class SessionAudit {
  constructor() {
    this.findings = [];
    this.banked = new Map();        // 值 -> { kind, from }
    this.pending = new Map();       // callId -> { sensitive?, envDump?, from? }
    this.readPaths = new Map();     // 敏感路径 -> true（Map 是为了保序的同时 O(1) 去重）
    this.bytes = 0;
    this.suppressed = 0;            // 超过上限后被压掉的命中数
    this.order = 0;
  }

  /** 喂完一个会话后调用；也可以中途查询 full 决定是否继续喂。 */
  get full() {
    return this.bytes > 32 * 1024 * 1024 || this.findings.length >= 60;
  }

  call(op) {
    this.order += 1;
    if (op.kind === 'read') {
      this.bytes += (op.path || '').length;
      if (isSensitivePath(op.path)) {
        const fresh = !this.readPaths.has(op.path);
        this.readPaths.set(op.path, true);
        // 同一个文件读三次只报一次：重复读取不是新的风险，它只是把同一句
        // 提示重复印在页面上。
        if (fresh) this.pushFinding('info', 'sensitive-read', op.path, null, op.path);
      }
      if (op.id) this.pending.set(op.id, { sensitive: isSensitivePath(op.path), envDump: false, from: op.path });
      return;
    }
    const text = op.kind === 'web' ? `${op.url || ''} ${op.text || ''}` : (op.text || '');
    this.bytes += text.length;
    if (!text) return;
    // 只看前 SCAN_WINDOW：更长的部分照样计入 bytes，但不参与正则。
    const scan = text.length > SCAN_WINDOW ? text.slice(0, SCAN_WINDOW) : text;

    const outbound = isOutbound(scan, op.kind);
    // cmd 与 code（Codex 的 exec 是 JS 源码，读文件也在里面）都从文本里认路径；
    // web 事件的文本是查询词/URL，认路径只会误报
    const paths = op.kind === 'web' ? [] : sensitivePathsIn(scan);
    for (const p of paths) {
      const fresh = !this.readPaths.has(p);
      this.readPaths.set(p, true);
      if (fresh) this.pushFinding('info', 'sensitive-read', p, null, p);
    }
    if (op.id) {
      this.pending.set(op.id, {
        sensitive: paths.length > 0,
        // env 倾倒：没有外发、但确实把整份环境变量打出来了 —— 它的输出要进 bank
        envDump: !outbound && /(?:^|[\s|;&(])(?:printenv|env)(?:$|[\s|;&)])/.test(scan),
        from: paths[0] || null,
      });
    }

    // P2：外发文本里内嵌凭据样式（P1 命中过的值不重复报）
    if (outbound) {
      const tokens = scanTokens(scan);
      const fired = new Set();
      for (const t of tokens) {
        if (fired.has(t.value)) continue;
        fired.add(t.value);
        this.pushFinding('medium', 'secret-inline', t.value, scan, null, t.kind);
      }
    }

    // P1：外发文本里出现 bank 里的值 —— 顺序天然成立（bank 只在更早的输出里入）
    if (outbound) {
      for (const [value, meta] of this.banked) {
        if (value.length < 8) continue;
        if (!scan.includes(value)) continue;
        this.pushFinding('high', 'secret-out', value, scan, meta.from, meta.kind, value);
      }
    }
  }

  out({ id, text }) {
    this.bytes += (text || '').length;
    const info = id ? this.pending.get(id) : null;
    if (!info || !text) {
      if (id) this.pending.delete(id);
      return;
    }
    if (!(info.sensitive || info.envDump)) return;
    // 输出方向同样限制扫描窗口：Read 回来的文件内容常常几百 KB，
    // 而凭据总在前几行（.env 就几十行）。
    const scan = text.length > SCAN_WINDOW ? text.slice(0, SCAN_WINDOW) : text;
    for (const t of scanTokens(scan)) this.bank(t.value, t.kind, info.from || '命令输出');
    for (const kv of kvSecretsIn(scan)) this.bank(kv.value, kv.key, info.from || '命令输出');
    if (id) this.pending.delete(id);
  }

  bank(value, kind, from) {
    if (!value || value.length < 8 || PLACEHOLDER.has(value.toLowerCase())) return;
    if (!this.banked.has(value)) this.banked.set(value, { kind, from: from || '敏感文件' });
  }

  pushFinding(level, kind, value, text, from, style, rawValue) {
    if (this.findings.length >= 60) { this.suppressed += 1; return; }
    const at = text ? Math.max(0, text.indexOf(rawValue ?? value)) : 0;
    this.findings.push({
      level,
      kind,
      // 展示用的样式名（aws-key / url-creds / password …），不带值
      style: style || null,
      from: from || null,
      valueMasked: maskSecret(value),
      evidence: text ? buildEvidence(text, [...this.banked.keys(), value], at) : String(value).slice(0, 120),
      order: this.order,
    });
  }

  /** 终检 + 汇总。终检是不变量的最后一道闸：evidence 里只要还找得到任何
   *  一个 bank 值或样式原文，就地再脱一次 —— 宁可证据变成一串圆点，
   *  也不放一个字符的原文出去。 */
  done() {
    const values = [...this.banked.keys()];
    for (const f of this.findings) {
      if (!f.evidence) continue;
      let ev = f.evidence;
      for (const v of values) {
        if (v.length >= 4 && ev.includes(v)) ev = ev.split(v).join(maskSecret(v));
      }
      // evidence 本身已经是短窗口（≤200 字符），但它可能由调用方塞进来，
      // 长度不由我们保证 —— 先截到窗口大小再跑正则。
      const scanEv = ev.length > SCAN_WINDOW ? ev.slice(0, SCAN_WINDOW) : ev;
      for (const t of scanTokens(scanEv)) ev = ev.split(t.value).join(maskSecret(t.value));
      f.evidence = ev.length > SCAN_WINDOW ? ev.slice(0, 200) : ev;
    }
    const findings = this.findings.slice(0, 40);
    const info = findings.filter((f) => f.level === 'info').length;
    const paths = [...this.readPaths.keys()];
    return {
      findings,
      suppressed: this.suppressed + Math.max(0, this.findings.length - findings.length),
      // P3 只回路径与计数：哪些路径被读过，超过 12 个的只给数
      sensitiveReads: paths.slice(0, 12),
      sensitiveReadCount: paths.length,
      bytes: this.bytes,
      infoCount: info,
    };
  }
}
