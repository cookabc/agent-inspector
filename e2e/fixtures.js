import { fixturePayload } from "./data.mjs";
export async function installFixtures(page, { holdInitial = false, failInitial = false } = {}) {
  const control = { requests: [], releaseInitial: null };
  let scans = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    control.requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === "/api/scan") {
      const first = ++scans === 1;
      if (first && holdInitial)
        await new Promise((resolve) => {
          control.releaseInitial = resolve;
        });
      if (first && (failInitial || holdInitial)) {
        await route.fulfill({ status: 503, json: { error: "合成扫描失败" } });
        return;
      }
    }
    const data = fixturePayload(url);
    if (!data || request.method() !== "GET") {
      await route.fulfill({ status: 405, json: { error: "Writes are disabled in these fixtures" } });
      return;
    }
    await route.fulfill({ json: data });
  });
  return control;
}
