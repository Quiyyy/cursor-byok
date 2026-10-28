import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const executable = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(root, "target"), "debug", process.platform === "win32" ? "cursor-server.exe" : "cursor-server");

export const test = base.extend({
  app: async ({ playwright }, use, testInfo) => {
    const directory = await mkdtemp(path.join(tmpdir(), "byok-ui-"));
    const appData = path.join(directory, "appdata");
    await mkdir(appData);
    const child = spawn(executable, [], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        CURSOR_BYOK_DATA_DIR: directory,
        CURSOR_APP_DIR: path.join(directory, "missing-cursor"),
        APPDATA: appData,
        CURSOR_DATABASE_URL: `sqlite://${path.join(directory, "test.db")}`,
        CURSOR_LISTEN_ADDR: "127.0.0.1:0",
        CURSOR_CONSOLE_DIR: path.join(root, "apps/desktop/dist"),
        CURSOR_CONSOLE_PROXY: undefined,
        RUST_LOG: "cursor_server=info",
        NO_COLOR: "1",
        FORCE_COLOR: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    let api;
    try {
      const origin = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Server did not start:\n${logs}`)), 15_000);
        const finish = (error, value) => { clearTimeout(timeout); error ? reject(error) : resolve(value); };
        child.once("error", error => finish(error));
        child.once("exit", code => finish(new Error(`Server exited (${code}):\n${logs}`)));
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
          logs += chunk.toString();
          const address = logs.match(/cursor server listening[^\n]*address=(127\.0\.0\.1:\d+)/)?.[1];
          if (address) finish(null, `http://${address}`);
        });
      });
      api = await playwright.request.newContext({ baseURL: origin });
      const response = await api.post("/__byok-api__/api/models", { data: { models: [{
        type: "openai", display_name: "Acceptance model", model_id: "gpt-test",
        base_url: "http://127.0.0.1:1/v1", api_key: "fixture", tooltip_data: "test",
      }] } });
      expect(response.ok(), await response.text()).toBeTruthy();
      const [model] = await response.json();
      await use({ origin, api, model });
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await api?.dispose();
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach("server.log", { body: logs, contentType: "text/plain" });
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
});

export { expect };
