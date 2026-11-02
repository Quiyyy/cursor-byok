import { test, expect } from "./fixture.mjs";

test.beforeEach(async ({ page, app }) => {
  await page.setViewportSize({ width: 820, height: 558 });
  // Only the plugin catalog is synthetic; use the real page, dialog and scroll controls.
  const plugin = {
    id: "catalog-fixture", name: "Catalog fixture", version: "0.1.0", author: null,
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
    resources: [],
    providers: [{
      id: "catalog", displayName: "Catalog fixture", configured: true, hasModels: true,
      models: Array.from({ length: 8 }, (_, index) => ({
        id: `catalog-${index + 1}`, modelId: `model-${index + 1}`,
        displayName: `Catalog model ${index + 1}`, enabled: false,
      })),
    }],
  };
  await page.route("**/__byok-api__/api/plugins", route => route.fulfill({ json: [plugin] }));
  await page.route("**/__byok-api__/api/plugins/runtime", route => route.fulfill({ json: { state: "ready" } }));
  await page.goto(`${app.origin}/__byok-api__/#/providers`);
  await page.getByRole("button", { name: "模型目录", exact: true }).click();
});

test("checking a model after scrolling keeps the visible catalog rows in place", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Catalog fixture", exact: true });
  const label = number => dialog.locator("label").filter({ hasText: `Catalog model ${number}` });
  await expect(label(1)).toBeInViewport({ ratio: 1 });
  await expect(label(8)).not.toBeInViewport();
  const footer = dialog.getByRole("button", { name: "保存模型选择", exact: true });
  const footerBefore = await footer.boundingBox();
  await label(3).hover();
  await page.mouse.wheel(0, 600);
  for (const number of [6, 7, 8]) await expect(label(number)).toBeInViewport({ ratio: 1 });
  const before = await label(7).boundingBox();

  // Click the visible label, as a user does; do not set the hidden input directly.
  await label(7).click();
  await expect(dialog.getByRole("checkbox", { name: "Catalog model 7", exact: true })).toBeChecked();
  await expect(dialog.getByText("1 项更改待保存", { exact: true })).toBeVisible();
  for (const number of [6, 7, 8]) await expect(label(number)).toBeInViewport({ ratio: 1 });
  expect((await label(7).boundingBox()).y).toBeCloseTo(before.y, 0);
  expect(await footer.boundingBox()).toEqual(footerBefore);
  await expect(footer).toBeInViewport({ ratio: 1 });

  await label(7).click();
  await expect(dialog.getByRole("checkbox", { name: "Catalog model 7", exact: true })).not.toBeChecked();
  await expect(label(7)).toBeInViewport({ ratio: 1 });
});

test("keyboard focus reveals each model and Space toggles it without clipping the catalog", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "Catalog fixture", exact: true });
  const checkbox = number => dialog.getByRole("checkbox", { name: `Catalog model ${number}`, exact: true });
  const label = number => dialog.locator("label").filter({ hasText: `Catalog model ${number}` });
  const footer = dialog.getByRole("button", { name: "保存模型选择", exact: true });
  const footerBefore = await footer.boundingBox();
  await dialog.getByRole("textbox", { name: "搜索模型", exact: true }).click();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "添加筛选结果", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "移除筛选结果", exact: true })).toBeFocused();
  for (let number = 1; number <= 8; number++) {
    await page.keyboard.press("Tab");
    await expect(checkbox(number)).toBeFocused();
    await expect(label(number)).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Space");
    await expect(checkbox(number)).toBeChecked();
    await expect(label(number)).toBeInViewport({ ratio: 1 });
  }
  for (let number = 7; number >= 1; number--) {
    await page.keyboard.press("Shift+Tab");
    await expect(checkbox(number)).toBeFocused();
    await expect(label(number)).toBeInViewport({ ratio: 1 });
  }
  await expect(dialog.getByText("8 项更改待保存", { exact: true })).toBeVisible();
  expect(await footer.boundingBox()).toEqual(footerBefore);
  await expect(footer).toBeInViewport({ ratio: 1 });
});
