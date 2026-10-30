import test from "node:test";
import assert from "node:assert/strict";
import { readJson, scanResponse, allResponse } from "../public/requests.js";
test("malformed scan and cross-tool payloads reject before consumers can commit them", async () => {
  await assert.rejects(
    readJson("/api/scan", scanResponse, async () => new Response("{}")),
    /数据不完整/,
  );
  await assert.rejects(
    readJson("/api/tasks/all", allResponse, async () => new Response('{"tasks":[],"tools":[]}')),
    /数据不完整/,
  );
});
test("an HTML error page produces a recovery message instead of a JSON parser trace", async () => {
  await assert.rejects(
    readJson(
      "/api/scan",
      scanResponse,
      async () => new Response("<html>unavailable</html>", { status: 503 }),
    ),
    /HTTP 503/,
  );
});
test("a structured service error keeps its useful explanation", async () => {
  await assert.rejects(
    readJson("/api/scan", scanResponse, async () => new Response('{"error":"测试错误"}', { status: 409 })),
    /测试错误/,
  );
});
