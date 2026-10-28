/**
 * 「安全审计」视图的渲染层。纯函数，不碰 DOM、不读全局状态。
 *
 * 这一屏只读：列出凭据外泄的命中与证据，不给任何删除入口。
 * 服务端下发的 valueMasked / evidence 已经脱敏，这里的职责是
 * 分档、排序、把每种命中的"是什么"说成人话。
 */

import { esc, shortPath } from './shared.js';
import { fmtBytes } from '../logic.js';

/* 样式 → 人话。key 是 lib/audit.mjs 里的 kind/样式名，两边的字典必须一起改。 */
export const AUDIT_LEVEL = {
  high: { label: '高危', cls: 'st-critical' },
  medium: { label: '疑似', cls: 'st-warning' },
};

export const AUDIT_STYLE = {
  'aws-key': 'AWS 访问密钥', github: 'GitHub 令牌', 'api-key': 'API key',
  stripe: 'Stripe 密钥', slack: 'Slack 令牌', google: 'Google API 密钥',
  jwt: 'JWT', bearer: 'Bearer 令牌', 'url-creds': 'URL 内嵌的账号密码',
};

/** bank 来源是 KV 键名（password / token…），转成"密码 / 令牌"。 */
export const AUDIT_KEY = {
  password: '密码', passwd: '密码', pwd: '密码', secret: '密钥', token: '令牌',
  api_key: 'API key', apikey: 'API key', access_key: '访问密钥',
  secret_key: '私钥', private_key: '私钥', client_secret: '客户端密钥',
};

export const auditStyleName = (f) =>
  AUDIT_STYLE[f.style] || AUDIT_KEY[f.style] || (f.style ? f.style : '凭据');

export const auditCount = (s, level) => s.findings.filter((f) => f.level === level).length;

/** 全局汇总：三档计数、扫描规模、各 app 的读取问题。 */
export function auditSummary(d) {
  return {
    totals: d.apps.reduce((a, x) => ({
      h: a.h + (x.totals?.high || 0), m: a.m + (x.totals?.medium || 0), i: a.i + (x.totals?.info || 0),
    }), { h: 0, m: 0, i: 0 }),
    scanned: d.apps.reduce((s, a) => s + (a.sessionsScanned || 0), 0),
    bytes: d.apps.reduce((s, a) => s + (a.bytesScanned || 0), 0),
    truncated: d.apps.reduce((s, a) => s + (a.truncatedSessions || 0), 0),
    problems: d.apps.flatMap((a) => (a.problems || []).map((p) => `${a.label}：${p}`)),
  };
}

/** 顶部那句话。 */
export function auditLedeHtml(d, s) {
  return `把 <b>${s.scanned.toLocaleString()}</b> 个会话的正文（约 ${fmtBytes(s.bytes)}）过了一遍：` +
    `<b>${s.totals.h}</b> 处高危（读到又外发）、<b>${s.totals.m}</b> 处疑似（外发内嵌）、` +
    `<b>${s.totals.i}</b> 次敏感文件读取。` +
    `<span class="all-note">证据已脱敏；这一屏只读，要处理去对应工具。</span>` +
    (s.truncated ? `<span class="all-note">${s.truncated} 个会话有内容未扫描，结果不完整。</span>` : '') +
    (s.problems.length ? `<span class="all-note">${esc(s.problems[0])}${s.problems.length > 1 ? ` 等 ${s.problems.length} 条` : ''}</span>` : '');
}

/** 每个 app 一枚状态签。三种形态：暂不支持 / 未安装 / 三档计数。 */
export function auditToolHtml(a) {
  const tone = `data-app-tone="${esc(a.app)}"`;
  if (!a.supported) {
    return `<span class="all-tool" ${tone} title="${esc(a.reason || '')}">${esc(a.label)} 暂不支持</span>`;
  }
  if (a.absent) {
    return `<span class="all-tool" ${tone} title="${esc(a.label)}：这台机器上没有">${esc(a.label)} 未安装</span>`;
  }
  const t = a.totals;
  /* 高危/疑似各带色显示，第三个数字是"读过敏感文件"——它中性、无标签，
     容易被读成"还有 40 处问题"。所以给它加个小字后缀，把三档说清楚。 */
  const many = [];
  if (t.high) many.push(`<em class="is-high">${t.high}</em>`);
  if (t.medium) many.push(`<em class="is-med">${t.medium}</em>`);
  if (t.info) many.push(`<em>${t.info}</em><i class="audit-unit">次读取</i>`);
  return `<span class="all-tool" ${tone} title="${esc(a.label)}：扫了 ${a.sessionsScanned} 个会话，用时 ${a.ms} ms${
    a.truncatedSessions ? `，${a.truncatedSessions} 个超长被截断` : ''}${
    a.hitsDropped ? `，另有 ${a.hitsDropped} 个命中会话没列出` : ''}">
    ${esc(a.label)} ${many.join('')}
  </span>`;
}

/** 只有高危/疑似的会话才成组；只有"读过敏感文件"的会话进不了列表 ——
 *  那是背景知识，全摆出来会把真问题淹了。 */
export function auditHitGroups(d) {
  return d.apps
    .flatMap((a) => (a.hits || []).map((h) => ({ app: a, h })))
    .filter(({ h }) => auditCount(h, 'high') + auditCount(h, 'medium') > 0)
    .sort((x, y) =>
      (auditCount(y.h, 'high') - auditCount(x.h, 'high')) ||
      (auditCount(y.h, 'medium') - auditCount(x.h, 'medium')));
}

/** 一个命中会话的整块：逐条发现 + 背景信息（敏感读取、截断说明）。 */
export function auditGroupHtml(app, h) {
  const rows = h.findings
    .filter((f) => f.level !== 'info')
    .map((f) => {
      const lv = AUDIT_LEVEL[f.level];
      const what = f.kind === 'secret-out'
        ? `读到的${auditStyleName(f)}又出现在外发命令里${f.from && f.from !== '命令输出' ? `（读取来源 ${esc(shortPath(f.from))}）` : ''}`
        : `外发命令里内嵌了${auditStyleName(f)}`;
      return `<div class="audit-row">
          <span class="audit-level ${lv.cls}">${lv.label}</span>
          <div class="audit-body">
            <p class="audit-what">${what} <code class="audit-val">${esc(f.valueMasked)}</code></p>
            ${f.evidence ? `<code class="audit-ev">${esc(f.evidence)}</code>` : ''}
          </div>
        </div>`;
    }).join('');
  const info = h.sensitiveReadCount
    ? `<p class="audit-info">另读过 ${h.sensitiveReadCount} 个敏感文件${h.sensitiveReads?.length ? `：${h.sensitiveReads.slice(0, 4).map((p) => esc(p.split('/').pop())).join('、')}${h.sensitiveReadCount > 4 ? ' 等' : ''}` : ''}${h.truncated ? '；部分内容因扫描上限被跳过，结果不完整' : ''}</p>`
    : (h.truncated ? '<p class="audit-info">部分内容因扫描上限被跳过，结果不完整</p>' : '');
  return `<section class="all-group">
      <header class="all-group-head">
        <span class="all-app" data-app-tone="${esc(app.app)}">${esc(app.label)}</span>
        <span class="all-title" title="${esc(h.title)}">${esc(h.title)}</span>
        <span class="all-group-n">${h.bodyRel ? esc(h.bodyRel) : ''}</span>
      </header>
      ${rows}${info}
    </section>`;
}
