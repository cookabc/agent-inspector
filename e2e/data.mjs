/** Public, synthetic records shared by local previews and hermetic browser tests. */
const cache = {
  id: "cache",
  label: "缓存",
  status: "good",
  verdict: "safe",
  recommend: true,
  count: 1,
  bytes: 12,
  what: "测试缓存",
  why: "合成数据",
  outcome: "可重新生成。",
};
const protectedCategory = {
  id: "credentials",
  label: "凭据",
  status: "critical",
  verdict: "never",
  locked: true,
  count: 1,
  bytes: 12,
  what: "测试配置",
  why: "受保护",
  outcome: "请勿删除。",
};
const apps = ["zcode", "cursor"].map((app) => ({
  app,
  label: app,
  targets: [{ key: "root", path: "/fixture/" + app, short: "/fixture/" + app, exists: true }],
  totals: { bytes: 24, files: 2, dirs: 1 },
  categories: [cache, protectedCategory],
  catalog: [cache, protectedCategory],
  files: [
    { t: "root", p: "cache/a", s: 12, m: 1, c: "cache" },
    { t: "root", p: "auth.json", s: 12, m: 1, c: "credentials" },
  ],
  canRecover: app === "cursor",
}));
export function fixturePayload(url) {
  if (url.pathname === "/api/scan")
    return {
      apps,
      grand: { bytes: 48 },
      durationMs: 1,
      canTrash: true,
      canReveal: true,
      confirm: { FILES: "彻底删除", SESSION: "清理", SESSION_ACTIVE: "删除活跃会话", RECOVER: "回灌" },
    };
  if (url.pathname === "/api/tasks/all")
    return { tasks: [], tools: [], groups: [], total: 0, bytes: 0, problems: [], durationMs: 1 };
  if (url.pathname === "/api/audit")
    return {
      apps: [
        {
          app: "zcode",
          label: "zcode",
          supported: true,
          sessionsScanned: 1,
          bytesScanned: 12,
          totals: { high: 0, medium: 0, info: 0 },
          hits: [],
          problems: [],
        },
      ],
    };
  if (url.pathname === "/api/tasks") {
    const appId = url.searchParams.get("app");
    return {
      appId,
      appLabel: appId,
      app: { running: false, hits: [] },
      tasks: [],
      history: appId + "-db",
      canRecover: false,
      totals: { count: 0, bytes: 0, byState: [] },
      db: { total: 0, dbs: [] },
      problems: [],
    };
  }
  return null;
}
