import { test, expect } from "@playwright/test";
import { installFixtures } from "./fixtures.js";

test("a failed initial scan has a visible recovery action", async ({ page }) => {
  await installFixtures(page, { failInitial: true });
  await page.goto("/");
  await expect(page.locator("#scanError")).toBeVisible();
  await expect(page.locator("#single")).toHaveAttribute("aria-busy", "false");
  await page.locator("[data-retry-scan]").click();
  await expect(page.locator("#scanError")).toBeHidden();
  await expect(page.locator("#heroBytes")).toContainText("24");
});
test("an obsolete scan failure cannot replace a successful rescan", async ({ page }) => {
  const fixture = await installFixtures(page, { holdInitial: true });
  await page.goto("/");
  await expect.poll(() => typeof fixture.releaseInitial).toBe("function");
  await page.locator("#rescanBtn").click();
  await expect(page.locator("#heroBytes")).toContainText("24");
  fixture.releaseInitial();
  await expect(page.locator("#scanError")).toBeHidden();
  await expect(page.locator("#heroSub")).not.toContainText("扫描失败");
  await expect(page.locator("#scanNote")).not.toHaveText("出错");
});
test("tool tabs, read-only audit and narrow layouts remain usable", async ({ page }) => {
  const fixture = await installFixtures(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#apptab-zcode")).toBeVisible();
  await page.locator("#apptab-zcode").focus();
  await page.keyboard.press("Home");
  await page.locator("#apptab-audit").click();
  await expect(page.locator("#auditView")).toBeVisible();
  await expect(page.locator("#auditLede")).not.toContainText("正在");
  expect(fixture.requests.every((request) => request.method === "GET")).toBe(true);
  await page.setViewportSize({ width: 320, height: 740 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
  expect(errors).toEqual([]);
});

test("malformed cross-tool data reports a readable failure without crashing the page", async ({ page }) => {
  await installFixtures(page);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/tasks/all", (route) => route.fulfill({ json: { tasks: [], tools: [] } }));
  await page.goto("/");
  await page.locator("#apptab-all").click();
  await expect(page.locator("#allLede")).toContainText("数据不完整");
  expect(errors).toEqual([]);
});
