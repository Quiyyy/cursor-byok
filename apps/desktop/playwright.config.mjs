import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/ui",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 120_000,
  outputDir: "../../target/ui-tests/results",
  reporter: [["list"], ["html", { outputFolder: "../../target/ui-tests/report", open: "never" }]],
  use: {
    browserName: "chromium",
    locale: "zh-CN",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
