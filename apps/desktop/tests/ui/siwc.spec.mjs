import { test, expect } from "./fixture.mjs";

test("SIWC reauthorization selects a saved registration and cancellation releases its flow", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  const plugin = {
    id: "dev.cursorbyok.chatgpt-auth", name: "ChatGPT (SIWC)", version: "0.1.0", author: null,
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", providers: [],
    resources: [{
      type: "chatgpt-account", displayName: "ChatGPT 授权账号", import: null, actions: [], canRefresh: false, canRemove: true,
      add: [{ type: "oauth2.authorization-code", id: "chatgpt", displayName: "继续使用 ChatGPT", description: "官方计划授权", canRegister: true, callback: { path: "/auth/callback", port: null } }],
      resources: [{ id: "saved-account", displayName: "fixture@example.test · client-1", state: { status: "invalid" }, description: null, metrics: [], createdAtMs: 1, selected: true,
        links: [{ label: "管理用量", url: "https://chatgpt.com/settings/usage" }] }],
    }],
  };
  let selected;
  let cancelled = 0;
  const opened = [];
  await page.route("**/__byok-api__/api/plugins", route => route.fulfill({ json: [plugin] }));
  await page.route("**/__byok-api__/api/plugins/runtime", route => route.fulfill({ json: { state: "ready" } }));
  await page.route("**/resources/chatgpt-account/add/chatgpt/begin*", route => {
    selected = new URL(route.request().url()).searchParams.get("resource_id");
    return route.fulfill({ json: { sessionId: "fixture-session", userCode: null, verificationUrl: "https://auth.openai.com/fixture", expiresAtMs: Date.now() + 60000, pollIntervalMs: 1000 } });
  });
  await page.route("**/plugins/oauth/fixture-session/poll", route => route.fulfill({ json: { status: "pending", pollIntervalMs: 1000 } }));
  await page.route("**/plugins/oauth/fixture-session", route => { cancelled++; return route.fulfill({ status: 204 }); });
  // Observe the existing browser-open boundary without opening an authentication page in CI.
  await page.route("**/__byok-api__/api/desktop/open-external-url", route => {
    opened.push(route.request().postDataJSON().url);
    return route.fulfill({ status: 204 });
  });
  await page.goto(`${app.origin}/__byok-api__/#/providers`);
  await page.getByRole("button", { name: "管理账号", exact: true }).click();
  await expect(page.getByText("当前账号", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "管理用量", exact: true }).click();
  await expect.poll(() => opened[0]).toBe("https://chatgpt.com/settings/usage");
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByRole("button", { name: /授权账号/ }).click();
  await page.getByRole("option", { name: "fixture@example.test · client-1", exact: true }).click();
  await page.getByRole("button", { name: "继续使用 ChatGPT", exact: true }).click();
  await expect.poll(() => selected).toBe("saved-account");
  await expect.poll(() => opened[1]).toBe("https://auth.openai.com/fixture");
  await expect(page.getByRole("button", { name: "等待网页端确认授权中…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect.poll(() => cancelled).toBe(1);
  await expect(page.getByRole("button", { name: "继续使用 ChatGPT", exact: true })).toBeEnabled();
});
