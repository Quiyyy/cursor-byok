import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("feature failures are isolated and model mutations never query takeover", async () => {
  const originalFetch = globalThis.fetch;
  const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key,value) => saved.set(key,value) };
  globalThis.window = { location: {protocol:"http:",hostname:"127.0.0.1"}, setTimeout, clearTimeout };
  globalThis.document = { documentElement: {dataset:{}} };
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
    globalThis.fetch = originalFetch;
    await server.close();
  }
});
