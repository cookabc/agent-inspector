/**
 * 会话级联删除：一条会话的库行 + 它在磁盘上的专属文件，一次做完。
 *
 * 为什么需要这一层：
 * 以前两条线是分开的 —— /api/tasks/purge 只删数据库行，/api/purge 只删文件。
 * 结果是删完一条会话后，它的 rollout 正文、贴图、transcript 全留在盘上，
 * 变成孤儿，用户还得去文件清单再清一遍。而"我删了这条会话"在人的理解里
 * 就是"关于它的东西都没了"；两次操作、两个界面，中间那一步没人做。
 *
 * 【顺序是刻意的：备份 → 删库 → 删文件】
 * 反过来（先删库再备份文件）有两个不可接受的窗口：
 *   1. 备份文件时失败 → 库行已经没了，会话列表里查不到它，但文件全在。
 *      用户看到的是一条"消失的会话"，而占磁盘的东西一个没少。
 *   2. 库删完、文件删一半 → 既没有完整会话，也没有完整文件。
 * 所以先把**所有**要删的文件备份好，再动库；库删成功后删文件；
 * 文件删失败时库已经没了，但备份在手上，恢复路径是明确的。
 *
 * 【不含跨存储原子性】
 * 多个 SQLite 文件之间无法原子提交（database-write 里已说明）；
 * 文件删除更不可能和数据库事务回滚。所以这里不谎称"全成功或全失败"：
 * 每一步的结果都如实返回，失败时明确告诉用户"库已删、文件已备份在 X"。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { httpErr } from './http-error.mjs';

/**
 * 把一条会话的 contents 展开成要删的相对路径清单。
 *
 * 只取 removable 的文件 —— 否则会把「不删」的项（Cursor 搜索索引、
 * DSH 的 workspace.json）也丢进删除队列，那是这个功能最危险的失误。
 */
export function filesToRemove(contents) {
  if (!contents?.files) return [];
  return contents.files
    .filter((f) => f.removable && f.rel)
    .map((f) => ({ rel: f.rel, role: f.role, bytes: f.bytes || 0 }));
}

/**
 * 把一次级联删除拆成有序的阶段，便于预览与测试。
 *
 * @param {{dbIds: string[], files: Array<{rel: string, role: string, bytes: number}>}} plan
 * @returns {Array<{stage: string, what: string, count: number, bytes: number}>}
 */
export function describeCascade(plan) {
  const fileBytes = plan.files.reduce((s, f) => s + (f.bytes || 0), 0);
  const stages = [];
  if (plan.dbIds?.length) {
    stages.push({ stage: 'db', what: '删除数据库行', count: plan.dbIds.length, bytes: 0 });
  }
  if (plan.files?.length) {
    stages.push({ stage: 'backup', what: '备份会话文件', count: plan.files.length, bytes: fileBytes });
    stages.push({ stage: 'files', what: '移入废纸篓', count: plan.files.length, bytes: fileBytes });
  }
  return stages;
}

/**
 * 执行一次级联删除。
 *
 * 调用方负责所有闸门（进程检查、确认词、权限）；这里只做编排，
 * 所以它可以在 dry-run 下只走"算计划"那一半。
 *
 * @param {object} o
 * @param {string[]} o.dbIds            要删的会话 id（库行）
 * @param {Array<{rel, role, bytes}>} o.files   要删的文件（相对审计根）
 * @param {(ids: string[]) => Promise<any>} o.purgeDb   删库行的实现（各工具自己的）
 * @param {(rel: string, role: string) => Promise<any>} o.removeFile  删单个文件的实现
 * @param {(rel: string) => Promise<any>} o.backupFile  备份单个文件的实现（可返回 null 表示不需要）
 * @param {boolean} [o.dryRun]
 * @param {boolean} [o.trashed] 文件是否只是移入废纸篓（可撤销）—— 决定结果怎么措辞
 * @returns {Promise<{db: any, files: Array, failed: Array, backup: string|null}>}
 */
export async function runCascade({ dbIds, files, purgeDb, backupFile, removeFile, dryRun = false, trashed = false }) {
  const result = { db: null, files: [], failed: [], backup: null, trashed };

  if (dryRun) {
    return { ...result, dryRun: true, db: { ids: dbIds.length, dryRun: true }, files };
  }

  /* 阶段 1：备份全部文件。
     失败就整批中止 —— 此刻库还没动过，中止是干净的。
     一个文件都备份不了却继续删库，等于把唯一的退路丢掉。

     backupFile 返回 null 表示"这一批不需要备份"（走废纸篓时 rename 本身
     可撤销，多拷一份只是浪费磁盘）—— 空返回不算失败，只有抛错才中止。 */
  const backed = [];
  for (const f of files) {
    try {
      const b = await backupFile(f.rel);
      backed.push({ ...f, backup: b || null });
      if (b && !result.backup) result.backup = path.dirname(String(b));
    } catch (err) {
      throw httpErr(500,
        `备份失败，已放弃整批删除（数据库未改动）：${f.rel} —— ${err.message}`);
    }
  }

  /* 阶段 2：删库行。
     失败时文件仍完好、且已备份，报错里带上备份位置。 */
  if (dbIds?.length) {
    try {
      result.db = await purgeDb(dbIds);
      result.backup = result.backup || result.db?.backup || null;
    } catch (err) {
      const where = backed.length ? `；文件已备份到 ${result.backup}，未删除` : '';
      throw httpErr(err.statusCode || 500, `${err.message}${where}`);
    }
  }

  /* 阶段 3：删文件。逐项独立 —— 一项失败不该拖累其余项。
     到这一步库已经删了，所以每个失败项都必须能指名道姓地报告，
     并说明它已备份在哪（否则用户既丢了会话又不知道文件还在不在）。 */
  for (const f of backed) {
    try {
      const r = await removeFile(f.rel, f.role);
      result.files.push({ rel: f.rel, role: f.role, bytes: f.bytes, backup: f.backup, ...r });
    } catch (err) {
      result.failed.push({ rel: f.rel, role: f.role, bytes: f.bytes, backup: f.backup, error: err.message });
    }
  }

  /* 形状兼容：库那半的字段（perDb / freed / backup / integrity …）摊到顶层 ——
     这个接口的既有调用方与测试都按顶层读，级联只是给它加了 files/failed
     两样东西，不该顺手改坏已经能用的契约。 */
  const db = result.db || {};
  return {
    ...db,
    db,
    files: result.files,
    failed: result.failed,
    backup: result.backup || db.backup || null,
    cascade: describeCascade({ dbIds: dbIds || [], files }),
  };
}

/**
 * 级联删除的结果怎么说人话。抽屉和 toast 共用一份，避免两处措辞不一致
 * 而让人以为删了不同的东西。
 */
export function cascadeSummary(result) {
  const dbRows = result.db?.perDb?.reduce((s, x) => s + (x.deleted ?? x.count ?? 0), 0) ?? null;
  const fileBytes = result.files.reduce((s, f) => s + (f.bytes || 0), 0);
  const parts = [];
  if (dbRows != null) parts.push(`数据库 ${dbRows.toLocaleString()} 行`);
  if (result.files.length) parts.push(`${result.files.length} 个文件（${fmt(fileBytes)}）`);
  const body = parts.length ? parts.join(' · ') : '没有删除任何东西';
  return {
    ok: result.failed.length === 0,
    text: result.failed.length
      ? `${body}；${result.failed.length} 个文件没删成，已备份在 ${result.backup || '备份目录'}`
      : body,
    failed: result.failed,
  };
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
