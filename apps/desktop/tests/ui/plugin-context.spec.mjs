import { test, expect } from "./fixture.mjs";

test("enabling an account model exposes its context control without reloading", async ({ page, app }) => {
  const id = "plugin:google-fixture/antigravity/gemini-test";
  let enabled = false;
  let contextWindow = null;
  const settings = () => ({ context_window_tokens: contextWindow, default_context_window_tokens: 1048576 });
  // Account catalog and settings are controlled boundaries; exercise the actual
  // catalog dialog, shared stores, model page and context selection interaction.
  await page.route("**/__byok-api__/api/plugins", route => route.fulfill({ json: [{
    id: "google-fixture", name: "Google fixture", version: "0.1.0", resources: [],
    providers: [{ id: "antigravity", displayName: "Google fixture", configured: true, hasModels: true,
      models: [{ id, modelId: "gemini-test", displayName: "Gemini fixture", enabled }] }],
  }] }));
  await page.route("**/__byok-api__/api/plugins/runtime", route => route.fulfill({ json: { state: "ready" } }));
  await page.route("**/__byok-api__/api/plugins/google-fixture/providers/antigravity/models/enabled", async route => {
    enabled = route.request().postDataJSON().enabled;
    await route.fulfill({ json: {} });
  });
  await page.route("**/__byok-api__/api/model-settings", async route => {
    const response = await route.fetch();
    const original = await response.json();
    await route.fulfill({ json: { ...original, ...(enabled ? { [id]: settings() } : {}) } });
  });
  await page.route(/\/api\/models\/plugin%3Agoogle-fixture.*\/settings$/, async route => {
    if (route.request().method() === "PUT") contextWindow = route.request().postDataJSON().context_window_tokens;
    await route.fulfill({ json: settings() });
  });

  await page.goto(`${app.origin}/__byok-api__/#/providers`);
  await page.getByRole("button", { name: "模型目录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Google fixture", exact: true });
  await dialog.locator("label").filter({ hasText: "Gemini fixture" }).click();
  await dialog.getByRole("button", { name: "保存模型选择", exact: true }).click();
  await expect.poll(() => enabled).toBe(true);
  await expect(dialog.getByRole("button", { name: "保存模型选择", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("link", { name: "模型管理", exact: true }).click();
  await expect(page.getByText("Gemini fixture", { exact: true })).toBeVisible();
  const controls = page.getByRole("button", { name: "上下文窗口", exact: true });
  await expect(controls).toHaveCount(2);
  await expect(controls.last()).toHaveText("1m");
  await controls.last().click();
  await expect(page.getByRole("option", { name: "默认 1m", exact: true })).toBeVisible();
  expect(contextWindow).toBeNull();
  await page.getByRole("option", { name: "200k", exact: true }).click();
  await expect.poll(() => contextWindow).toBe(200000);
  await expect(controls.last()).toHaveText("200k");
  await page.reload();
  await expect(controls.last()).toHaveText("200k");
});
