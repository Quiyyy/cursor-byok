import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("feature failures are isolated and model mutations never query takeover", async () => {
  const originals = Object.fromEntries(["fetch","localStorage","window","document","t"].map(key=>[key,globalThis[key]]));
  const timers = new Set();
  const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key,value) => saved.set(key,value) };
  globalThis.window = { location: {protocol:"http:",hostname:"127.0.0.1"}, setTimeout: (callback,delay) => { const timer=setTimeout(callback,delay); timers.add(timer); return timer; }, clearTimeout };
  globalThis.document = { documentElement: {dataset:{}}, currentScript:null };
  globalThis.t = text => text;
  let models = [{model_hash:"one",model_id:"model-one",display_name:"One"}];
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url),"http://127.0.0.1").pathname.replace("/__byok-api__/api","");
    requests.push(path);
    let body;
    if (path === "/plugins") return Response.json({message:"Synthetic plugin failure"},{status:500});
    if (path === "/models") {
      if (options.method === "POST") models = [...models,{model_hash:"two",model_id:"model-two",display_name:"Two"}];
      body = models;
    } else if (path === "/plugins/runtime") body = {state:"ready"};
    else if (path === "/model-settings") body = {};
    else if (path === "/settings/cursor-model") body = {model_id:"",updated_at_ms:0};
    else if (path === "/harness/cursor/status") body = {ca:"ready",integration:"disabled"};
    else body = {};
    return Response.json(body);
  };
  const server = await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,server:{middlewareMode:true,watch:null},appType:"custom"});
  try {
    const {initializeApp} = await server.ssrLoadModule("/src/shell/refresh.ts");
    const {modelsStore} = await server.ssrLoadModule("/src/features/models/state.ts");
    const {pluginsStore} = await server.ssrLoadModule("/src/features/plugins/state.ts");
    const {cursorStore} = await server.ssrLoadModule("/src/features/cursor/state.ts");
    await initializeApp();
    assert.equal(modelsStore.getSnapshot().models.length,1);
    assert.equal(modelsStore.getSnapshot().error,null);
    assert.equal(cursorStore.getSnapshot().cursorHarness.integration,"disabled");
    assert.match(pluginsStore.getSnapshot().error,/Synthetic plugin failure/);
    requests.length = 0;
    await modelsStore.createModels([]);
    assert.equal(modelsStore.getSnapshot().models.length,2);
    assert(requests.length > 0);
    assert(requests.every(path=>["/models","/model-settings","/settings/cursor-model"].includes(path)),requests.join(","));
  } finally {
    timers.forEach(clearTimeout);
    Object.assign(globalThis,originals);
    await server.close();
  }
});

test("takeover has an accessible retry after an initial status failure", async () => {
  const originals = Object.fromEntries(["fetch","window","t"].map(key=>[key,globalThis[key]]));
  const timers = new Set();
  globalThis.window = { location: {protocol:"http:",hostname:"127.0.0.1"}, setTimeout: (callback,delay) => { const timer=setTimeout(callback,delay); timers.add(timer); return timer; }, clearTimeout };
  globalThis.t = text => text;
  const requests = [];
  let failing = true;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({url:String(url),method:options.method ?? "GET"});
    return failing
      ? Response.json({message:"Synthetic status failure"},{status:500})
      : Response.json({ca:"ready",integration:"disabled",settings_applied:false});
  };
  const server = await createServer({root:fileURLToPath(new URL("../",import.meta.url)),configFile:false,server:{middlewareMode:true,watch:null},appType:"custom"});
  try {
    const {cursorStore} = await server.ssrLoadModule("/src/features/cursor/state.ts");
    const {CursorTakeover} = await server.ssrLoadModule("/src/features/cursor/CursorTakeover.tsx");
    const {TooltipProvider} = await server.ssrLoadModule("/src/shared/ui/Tooltip.tsx");
    const render = () => renderToStaticMarkup(createElement(TooltipProvider,null,createElement(CursorTakeover)));
    await cursorStore.refresh();
    assert.equal(cursorStore.getSnapshot().cursorHarness,null);
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = render().match(/<button\b[^>]*aria-label="刷新接入状态"[^>]*>/)?.[0];
      assert(retry,"failed status must expose a retry outside the disabled takeover switch");
      assert(!retry.includes("disabled"),"retry must remain enabled after a failed read");
      await cursorStore.refresh();
    }
    failing = false;
    await cursorStore.refresh();
    assert.equal(cursorStore.getSnapshot().error,null);
    const markup = render();
    const toggle = markup.match(/<button\b[^>]*role="switch"[^>]*>/)?.[0];
    assert(toggle,"healthy status restores the takeover switch");
    assert(!toggle.includes("disabled"));
    assert(!markup.includes('aria-label="刷新接入状态"'));
    assert(requests.every(request => request.method === "GET" && request.url.endsWith("/harness/cursor/status")));
  } finally {
    timers.forEach(clearTimeout);
    Object.assign(globalThis,originals);
    await server.close();
  }
});
