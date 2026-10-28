import { test, expect } from "./fixture.mjs";

test("settings refresh recovers the model picker after catalog failures", async ({ page, app }) => {
  let failing = true;
  const failed = new Set();
  const recovered = new Set();
  await page.route(/\/__byok-api__\/api\/(models|plugins)$/, async route => {
    const resource = new URL(route.request().url()).pathname.split("/").at(-1);
    if (failing) {
      failed.add(resource);
      await route.fulfill({ status: 503, json: { message: "Temporary catalog failure" } });
    } else {
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      recovered.add(resource);
      await route.fulfill({ response });
    }
  });
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  await expect.poll(() => failed.size).toBe(2);
  const commit = page.getByText("Commit 提交代码模型设置", { exact: true }).locator("xpath=ancestor::section[1]");
  await commit.getByRole("button", { name: "编辑", exact: true }).click();
  await commit.getByRole("button", { name: /^筛选项：生成模型，/ }).click();
  await expect(page.getByRole("listbox", { name: "生成模型", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: /Acceptance model/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  failing = false;
  const harnessRequests = [];
  page.on("request", request => { if (request.url().includes("/harness/")) harnessRequests.push(request.url()); });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect.poll(() => recovered.size).toBe(2);
  await commit.getByRole("button", { name: /^筛选项：生成模型，/ }).click();
  await page.getByRole("option", { name: /Acceptance model/ }).click();
  await commit.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await (await app.api.get("/__byok-api__/api/settings/commit?locale=zh-CN")).json()).model_id).toBe(app.model.model_hash);
  expect(harnessRequests).toEqual([]);
});

test("setting a default model persists across a page reload", async ({ page, app }) => {
  await page.goto(`${app.origin}/__byok-api__/#/models`);
  await page.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(page.getByText("默认模型", { exact: true })).toBeVisible();
  const readDefault = async () => (await (await app.api.get("/__byok-api__/api/settings/cursor-model")).json()).model_id;
  await expect.poll(readDefault).toBe(app.model.model_hash);
  await page.reload();
  await expect(page.getByText("默认模型", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "设为默认", exact: true })).toHaveCount(0);
});

test("context window selection and reset persist through real settings endpoints", async ({ page, app }) => {
  await page.goto(`${app.origin}/__byok-api__/#/models`);
  const context = page.getByRole("button", { name: "上下文窗口", exact: true });
  await expect(context).toHaveText("1m");
  await context.click();
  await page.getByRole("option", { name: "200k", exact: true }).click();
  const readContext = async () => (await (await app.api.get(`/__byok-api__/api/models/${app.model.model_hash}/settings`)).json()).context_window_tokens;
  await expect.poll(readContext).toBe(200000);
  await page.reload();
  await expect(context).toHaveText("200k");
  await context.click();
  await page.getByRole("option", { name: "默认 1m", exact: true }).click();
  await expect.poll(readContext).toBeNull();
  await page.reload();
  await expect(context).toHaveText("1m");
});
