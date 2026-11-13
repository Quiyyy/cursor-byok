import { test, expect } from "./fixture.mjs";

test("settings categories preserve an unsaved external API key until saved", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  const card = page.getByText("外部 API", { exact: true }).locator("xpath=ancestor::section[1]");
  const input = card.locator("input[type=password]");
  await expect(input).toBeEnabled();
  await input.fill("unsaved-review-key");
  await page.getByRole("button", { name: "接口与网络", exact: true }).click();
  await expect(input).toHaveValue("unsaved-review-key");
  await page.getByRole("button", { name: "常规与外观", exact: true }).click();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "接口与网络", exact: true }).click();
  await expect(input).toHaveValue("unsaved-review-key");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(input).toHaveValue("unsaved-review-key");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await (await app.api.get("/__byok-api__/api/settings/external-api")).json()).api_key).toBe("unsaved-review-key");
  await page.reload();
  await expect(input).toHaveValue("unsaved-review-key");
});

test("settings categories preserve an unsaved Commit model until saved", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  const card = page.getByText("Commit 提交代码模型设置", { exact: true }).locator("xpath=ancestor::section[1]");
  const picker = card.getByRole("button", { name: /^筛选项：生成模型，/ });
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  await picker.click();
  await page.getByRole("option", { name: /Acceptance model/ }).click();
  await page.getByRole("button", { name: "Cursor 增强", exact: true }).click();
  await expect(picker).toContainText("Acceptance model");
  await page.getByRole("button", { name: "接口与网络", exact: true }).click();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "Cursor 增强", exact: true }).click();
  await expect(picker).toContainText("Acceptance model");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(picker).toContainText("Acceptance model");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(async () => (await (await app.api.get("/__byok-api__/api/settings/commit?locale=zh-CN")).json()).model_id).toBe(app.model.model_hash);
  await page.reload();
  await expect(card.getByText("Acceptance model（gpt-test）", { exact: true })).toBeVisible();
});

test("settings categories preserve unsaved pricing until saved", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  const card = page.getByText("Token 定价", { exact: true }).locator("xpath=ancestor::section[1]");
  const input = card.getByRole("spinbutton").first();
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  await input.fill("123");
  await page.getByRole("button", { name: "观测与存储", exact: true }).click();
  await expect(input).toHaveValue("123");
  await page.getByRole("button", { name: "接口与网络", exact: true }).click();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "观测与存储", exact: true }).click();
  await expect(input).toHaveValue("123");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(input).toHaveValue("123");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card.getByRole("button", { name: "编辑", exact: true })).toBeVisible();
  await page.reload();
  await expect(card.getByText("$123", { exact: true })).toBeVisible();
});

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

test("setting and clearing a default model persists across a page reload", async ({ page, app }) => {
  await page.goto(`${app.origin}/__byok-api__/#/models`);
  await page.getByRole("button", { name: "设为默认", exact: true }).click();
  await expect(page.getByRole("button", { name: "默认模型", exact: true })).toBeVisible();
  const readDefault = async () => (await (await app.api.get("/__byok-api__/api/settings/cursor-model")).json()).model_id;
  await expect.poll(readDefault).toBe(app.model.model_hash);
  await page.reload();
  await expect(page.getByRole("button", { name: "默认模型", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "设为默认", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "默认模型", exact: true }).click();
  await expect(page.getByRole("button", { name: "设为默认", exact: true })).toBeVisible();
  await expect.poll(readDefault).toBe("");
  await page.reload();
  await expect(page.getByRole("button", { name: "设为默认", exact: true })).toBeVisible();
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
