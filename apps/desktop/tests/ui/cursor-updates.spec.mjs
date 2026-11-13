import { test, expect } from "./fixture.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const status = {
  supported:true, unsupported_reason:null, enabled:true, current_version:"3.27.14", current_commit:"old",
  verified_release:{version:"3.28.7",commit:"25b52e7d03ebf2d5608914158e119f7992432a30",harness:"builtin"},
  current_verified:false, unverified_version:null, phase:"idle", busy:false, can_cancel:false,
  downloaded_bytes:0, total_bytes:null, candidate:null, error:null, recovery_required:false,
};

test("unverified Cursor updates expose the verification boundary without offering installation", async ({ page, app }) => {
  await page.setViewportSize({width:820,height:558});
  let current={...status};
  await page.route("**/api/cursor-update", route=>route.fulfill({json:current}));
  await page.route("**/api/cursor-update/check", route=>{
    current={...current,phase:"unverified",unverified_version:"3.30.8"};
    return route.fulfill({json:current});
  });
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  await page.getByRole("button",{name:"Cursor 增强",exact:true}).click();
  await expect(page.getByText("已验证组合：Cursor 3.28.7 · 内置 Harness",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"检查更新",exact:true}).click();
  await expect(page.getByText("未提供安装的新版本：3.30.8",{exact:true})).toBeVisible();
  await expect(page.getByText("官方新版本尚未通过验收，未下载或安装",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"更新并重启 Cursor",exact:true})).toHaveCount(0);
});

test("a prepared verified update requires confirmation and reports its asynchronous result", async ({ page, app }) => {
  await page.setViewportSize({width:820,height:558});
  let installs=0, polls=0;
  let current={...status,phase:"ready",candidate:{id:"fixture-candidate",version:"3.28.7",commit:status.verified_release.commit}};
  await page.route("**/api/cursor-update", route=>{
    if(current.busy && ++polls>1)current={...current,phase:"complete",busy:false,candidate:null,current_version:"3.28.7",current_verified:true};
    return route.fulfill({json:current});
  });
  // Only the OS update boundary is synthetic; exercise the real card, dialogs, and polling store.
  await page.route("**/api/cursor-update/install", route=>{
    expect(route.request().postDataJSON()).toEqual({candidate_id:"fixture-candidate"});installs++;
    current={...current,phase:"installing",busy:true};return route.fulfill({json:current});
  });
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  await page.getByRole("button",{name:"Cursor 增强",exact:true}).click();
  await page.getByRole("button",{name:"更新并重启 Cursor",exact:true}).click();
  const dialog=page.getByRole("alertdialog",{name:"更新并重启 Cursor",exact:true});
  await expect(dialog).toBeVisible();expect(installs).toBe(0);
  await dialog.getByRole("button",{name:"取消",exact:true}).click();expect(installs).toBe(0);
  await page.getByRole("button",{name:"更新并重启 Cursor",exact:true}).click();
  await dialog.getByRole("button",{name:"开始更新",exact:true}).click();
  await expect(page.getByText("正在安装 Cursor 更新…",{exact:true})).toBeVisible();
  await expect(page.getByText("Cursor 更新完成",{exact:true})).toBeVisible();expect(installs).toBe(1);
});

test("Windows managed settings persist and restore user edits without affecting model or external APIs", async ({ page, app }) => {
  test.skip(process.platform!=="win32","Exercises the real Windows settings/process boundary in an isolated directory");
  const settingsFile=path.join(app.appData,"Cursor/User/settings.json");
  await mkdir(path.dirname(settingsFile),{recursive:true});
  const original={"update.mode":"manual","cursor.agentHost.updateMode":"default","editor.fontSize":17};
  await writeFile(settingsFile,JSON.stringify(original));
  await mkdir(app.cursorApp,{recursive:true});
  await writeFile(path.join(app.cursorApp,"product.json"),JSON.stringify({nameShort:"Cursor",target:"user",quality:"stable",version:"3.30.8",commit:"unverified-build"}));
  const pe=Buffer.alloc(70);pe.write("MZ");pe.writeUInt32LE(64,60);pe.write("PE\0\0",64);pe.writeUInt16LE(0x8664,68);
  await writeFile(path.resolve(app.cursorApp,"../../Cursor.exe"),pe);
  await page.setViewportSize({width:820,height:558});
  await page.goto(`${app.origin}/__byok-api__/#/settings`);
  await page.getByRole("button",{name:"Cursor 增强",exact:true}).click();
  const toggle=page.getByRole("switch",{name:"由 BYOK 管理 Cursor 更新",exact:true});
  await toggle.click();
  await page.getByRole("alertdialog").getByRole("button",{name:"取消",exact:true}).click();
  expect(JSON.parse(await readFile(settingsFile,"utf8"))).toEqual(original);
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await page.getByRole("alertdialog").getByRole("button",{name:"确认并应用",exact:true}).click();
  await expect(toggle).toBeChecked();
  expect(JSON.parse(await readFile(settingsFile,"utf8"))).toEqual({...original,"update.mode":"none","update.enableWindowsBackgroundUpdates":false,"cursor.agentHost.updateMode":"none"});
  const unprepared=await app.api.post("/__byok-api__/api/cursor-update/install",{data:{candidate_id:"not-prepared"}});
  expect(unprepared.status()).toBe(400);expect((await unprepared.json()).message).toContain("Check the Cursor update");
  await page.reload();
  await page.getByRole("button",{name:"Cursor 增强",exact:true}).click();
  await expect(toggle).toBeChecked();
  const takeover=await app.api.put("/__byok-api__/api/harness/cursor/enabled",{data:{enabled:true}});
  expect(takeover.status()).toBe(400);expect((await takeover.json()).message).toContain("has not been verified");
  expect((await app.api.get("/__byok-api__/api/models")).ok()).toBeTruthy();
  expect((await app.api.put("/__byok-api__/api/settings/external-api",{data:{enabled:true,api_key:"isolated-test-key"}})).ok()).toBeTruthy();
  expect((await app.api.get("/byok/v1/models",{headers:{Authorization:"Bearer isolated-test-key"}})).ok()).toBeTruthy();
  const changed=JSON.parse(await readFile(settingsFile,"utf8"));changed["update.mode"]="start";await writeFile(settingsFile,JSON.stringify(changed));
  await toggle.click();
  await page.getByRole("alertdialog").getByRole("button",{name:"确认并应用",exact:true}).click();
  await expect(toggle).not.toBeChecked();
  expect(JSON.parse(await readFile(settingsFile,"utf8"))).toEqual({...original,"update.mode":"start"});
});
