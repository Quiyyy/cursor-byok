import { test, expect } from "./fixture.mjs";
import { createServer } from "node:http";

for (const takeoverEnabled of [false, true]) {
  test(`failed model tests keep quick start unverified with takeover ${takeoverEnabled ? "on" : "off"}`, async ({ page, app }) => {
    await page.setViewportSize({ width: 820, height: 558 });
    // Control only OS integration status; model testing and overview data use the real server.
    await page.route("**/api/harness/cursor/status", route => route.fulfill({ json: {
      ca: "ready", integration: takeoverEnabled ? "enabled" : "disabled", settings_applied: takeoverEnabled,
    } }));
    await page.goto(`${app.origin}/__byok-api__/#/models`);
    await page.getByRole("button", { name: "测试", exact: true }).click();
    await expect(page.getByRole("button", { name: "测试失败", exact: true })).toBeVisible();
    const overview = await (await app.api.get("/__byok-api__/api/overview")).json();
    expect(overview.metrics.failed_calls).toBe(1);
    expect(overview.metrics.successful_calls).toBe(0);

    await page.getByRole("link", { name: "运行概览", exact: true }).click();
    // Reload also proves that the result is derived from persisted calls, not a local test badge.
    await page.reload();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByText("快速开始", { exact: true })).toBeVisible();
    await expect(page.getByText("建议验证", { exact: true })).toBeVisible();
    await expect(page.getByText("已验证", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "不再提示", exact: true }).click();
    await expect(page.getByText("快速开始", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByText("快速开始", { exact: true })).toHaveCount(0);
  });
}

test("successful model test keeps quick start until Cursor takeover is enabled", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  const upstream = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      { type: "response.output_text.delta", delta: "ok" },
      { type: "response.completed", response: { status: "completed", output: [] } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const updated = await app.api.put(`/__byok-api__/api/models/${app.model.model_hash}`, { data: {
      ...app.model, base_url: `http://127.0.0.1:${upstream.address().port}/v1`,
    } });
    expect(updated.ok(), await updated.text()).toBeTruthy();
    let enabled = false;
    const status = () => ({ ca: "ready", integration: enabled ? "enabled" : "disabled", settings_applied: enabled });
    await page.route("**/api/harness/cursor/status", route => route.fulfill({ json: status() }));
    await page.route("**/api/harness/cursor/enabled", route => {
      enabled = route.request().postDataJSON().enabled;
      return route.fulfill({ json: status() });
    });
    await page.goto(`${app.origin}/__byok-api__/#/models`);
    await page.getByRole("button", { name: "测试", exact: true }).click();
    await expect(page.getByRole("button", { name: /通过 ·/ })).toBeVisible();
    const overview = await (await app.api.get("/__byok-api__/api/overview")).json();
    expect(overview.metrics.successful_calls).toBe(1);
    expect(overview.metrics.failed_calls).toBe(0);
    await page.getByRole("link", { name: "运行概览", exact: true }).click();
    await page.reload();
    await expect(page.getByText("已验证", { exact: true })).toBeVisible();
    await expect(page.getByText("未开启", { exact: true })).toBeVisible();
    await page.getByRole("switch", { name: "Cursor 接管", exact: true }).click();
    await expect(page.getByRole("switch", { name: "Cursor 接管", exact: true })).toBeChecked();
    await expect(page.getByText("快速开始", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await expect(page.getByText("快速开始", { exact: true })).toHaveCount(0);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
});

test("save and test preserves row test badge without duplicate PUT and flat mode drag handle never overlaps title", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  let putCount = 0;
  await page.route(/\/__byok-api__\/api\/models\/[^/]+$/, async route => {
    if (route.request().method() === "PUT") putCount += 1;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.route(/\/__byok-api__\/api\/models\/[^/]+\/test\/[^/]+$/, async route => {
    await route.fulfill({
      status: 200,
      json: {
        duration_ms: 180,
        first_valid_response_ms: 60,
        output_tokens: 12,
        tokens_per_second: 42.5,
        tokens_estimated: false,
        output: "ok",
      },
    });
  });

  await page.goto(`${app.origin}/__byok-api__/#/models`);
  await page.getByRole("button", { name: "编辑连接", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑模型", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("留空使用模型名称").fill("Renamed model");
  await dialog.getByRole("button", { name: "保存并测试", exact: true }).click();
  await expect(dialog.getByText("速度：42.5 tokens/s", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeVisible();
  expect(putCount).toBe(1);

  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(putCount).toBe(1);
  await expect(page.getByRole("button", { name: /通过 · 42\.5 tokens\/s/ })).toBeVisible();

  await page.getByRole("button", { name: "更多", exact: true }).first().click();
  await page.getByRole("menuitemradio", { name: "平铺与排序", exact: true }).click();
  const handle = page.getByRole("button", { name: "拖动排序", exact: true });
  const title = page.getByText("Renamed model", { exact: true });
  await expect(handle).toBeVisible();
  await expect(title).toBeVisible();
  const handleBox = await handle.boundingBox();
  const titleBox = await title.boundingBox();
  expect(handleBox && titleBox && handleBox.x + handleBox.width <= titleBox.x + 1).toBeTruthy();
});

test("overview toolbar model filter applies directly to range and annual activity at 820x558", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  const overviewQueries = [];
  page.on("request", request => {
    if (request.url().includes("/__byok-api__/api/overview?")) {
      overviewQueries.push(new URL(request.url()).searchParams);
    }
  });

  await page.goto(`${app.origin}/__byok-api__/#/`);
  const picker = page.getByRole("button", { name: /^筛选项：模型，/ });
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByRole("option", { name: /Acceptance model/ }).click();
  await page.keyboard.press("Escape");

  const expectedHashes = JSON.stringify([app.model.model_hash]);
  await expect.poll(() => overviewQueries.some(params => params.get("model_hashes") === expectedHashes && !params.has("bucket_ms"))).toBeTruthy();
  await expect.poll(() => overviewQueries.some(params => params.get("model_hashes") === expectedHashes && params.get("bucket_ms") === "86400000")).toBeTruthy();
});

test("calls table fits inside 820x558 without clipping and supports source filter, row click, and settings jump", async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  const sampleCall = {
    source: "commit",
    call_id: "call-ux-1",
    run_id: "run-1",
    conversation_id: "conv-1",
    model_hash: app.model.model_hash,
    provider_type: "openai",
    provider_url: "http://127.0.0.1:1/v1/responses",
    request_type: "responses",
    request_url: "/v1/responses",
    model_id: "gpt-test",
    display_name: "Acceptance model",
    reasoning_effort: "medium",
    fast: false,
    status: "failed",
    finish_reason: "error",
    created_at_ms: Date.now() - 5_000,
    ttfb_ms: 120,
    ttft_ms: null,
    ttfr_ms: null,
    duration_ms: 340,
    input_tokens: 128,
    output_tokens: 0,
    total_tokens: 128,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    message_count: 2,
    tool_count: 0,
    http_status: 429,
    error_kind: "upstream",
    error_message: "Rate limit exceeded",
    detailed: false,
  };
  await page.route(/\/__byok-api__\/api\/llm-calls\?limit=200$/, async route => {
    await route.fulfill({ status: 200, json: [sampleCall] });
  });
  await page.route(/\/__byok-api__\/api\/llm-calls\/call-ux-1$/, async route => {
    await route.fulfill({ status: 200, json: { call: sampleCall, request: null, response_chunks: [] } });
  });

  await page.goto(`${app.origin}/__byok-api__/#/calls`);
  await expect(page.getByRole("columnheader", { name: "Token", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("columnheader", { name: "操作", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.getByText("Rate limit exceeded", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "调用来源", exact: true }).click();
  await page.getByRole("option", { name: "External API", exact: true }).click();
  await expect(page.getByText("没有匹配的调用记录", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "调用来源", exact: true }).click();
  await page.getByRole("option", { name: "Commit", exact: true }).click();
  await page.getByRole("cell", { name: /Acceptance model/ }).click();

  const detailDialog = page.getByRole("dialog", { name: "Acceptance model", exact: true });
  await expect(detailDialog).toBeVisible();
  await expect(detailDialog.getByText("概览与状态", { exact: true })).toBeVisible();
  await detailDialog.getByRole("tab", { name: "请求", exact: true }).click();
  await detailDialog.getByRole("button", { name: "前往系统设置", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
});
