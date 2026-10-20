# 维护与开发

## 代码来源

- 当前维护仓库：[Quiyyy/cursor-byok](https://github.com/Quiyyy/cursor-byok)。
- 原项目：[leookun/cursor-byok](https://github.com/leookun/cursor-byok)，已归档。
- 接管基线：`31e9f5cbc98a7d28cffcb5efbb9323cd3e143354`，包含 v1.0.1 及之后的本地应用 External API。
- 保留上游 Git 历史、作者信息和 MIT 许可证。上游历史 PR [#459](https://github.com/leookun/cursor-byok/pull/459) 的改动在本仓库继续维护。

`origin` 指向当前维护仓库，`upstream` 指向原项目。日常开发使用 `codex/` 前缀的分支，以 `main` 为基线。

## 已合入的改动

- Grok、ChatGPT 和 Google 登录凭据共用 SDK 续期逻辑，在启动加载、模型调用、模型发现和手动刷新时按需续期。
- 同账号刷新串行化；刷新后的凭据先保存再调用模型，避免请求取消或并发结果覆盖新凭据。
- 区分临时网络错误与失效授权；首次、尚未输出内容的 401 可以刷新后重试一次。
- Grok 4.7 模型发现与思考参数适配；Grok 4.6 / 4.7 的 `max` 映射为 `xhigh`。
- 移除广告弹窗、广告菜单、广告请求、广告缓存读写和仅供广告使用的安装标识。
- 修复子代理接入与 Steer 后结果回传、MCP Schema 整数、Responses 文字回放、多段思考签名、Anthropic 拒绝处理、代理缓存失效及 SQLite 连接回收。范围与上游来源见[排查记录](./UPSTREAM-BUG-AUDIT.md)。
- CI 覆盖三类内置插件、共享 OAuth SDK，以及 Linux、Windows、macOS 的宿主凭据生命周期。

自动续期不能恢复服务商已撤销的授权。`invalid_grant` 等终止错误仍需要用户重新登录。

## 开发与验证

先阅读 [AGENTS.md](./AGENTS.md)。需要 Rust stable、Node.js、npm、Deno 2.9.6，以及对应平台的 Tauri 2 构建依赖。

```sh
npm --prefix apps/desktop ci
npm --prefix apps/desktop run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
deno test --config server/plugins/build-in/grok-auth/deno.json server/plugins/build-in/grok-auth/
deno test --config server/plugins/build-in/codex-auth/deno.json server/plugins/build-in/codex-auth/
deno test --config server/plugins/build-in/antigravity-auth/deno.json server/plugins/build-in/antigravity-auth/
deno test --import-map server/src/plugin/sdk/import-map.json server/src/plugin/sdk/oauth_test.ts
```

宿主凭据测试需要额外设置 `DENO_TEST_EXECUTABLE` 为 Deno 的可执行文件路径，再运行：

```sh
cargo test --package cursor-server --lib plugin:: -- --include-ignored
```

集成测试必须使用临时目录中的 `PluginRuntime::in_directory` 和 `PluginRegistry::in_directory`。测试中禁止调用 `managed()`，后者用于正式应用，可能安装内置插件并读取当前用户的账号。测试不需要真实账号、网络令牌或用户数据库。

本地启动使用 `make dev-web` 或 `make dev-desktop`。桌面生产构建使用 Tauri CLI（`npm --prefix apps/desktop run tauri:build`）或 `make build-desktop`，确保前端资源被嵌入。

## 独立发布

当前尚未发布本 fork 的安装包。仓库接管不自动替换本机已安装程序，也不迁移或上传用户账号配置。

- 安装版与 Windows 便携版的更新源均指向 `Quiyyy/cursor-byok` 的 GitHub Releases。
- fork 使用独立更新签名公钥；对应私钥通过仓库 Actions secret `TAURI_SIGNING_PRIVATE_KEY` 提供，私钥保存在仓库外，禁止提交。
- 上游旧安装包仍使用上游更新源和公钥。首次切换到本 fork 应手动安装；后续版本才通过本 fork 的签名更新链路升级。
- 首次发布选择高于 `1.0.1` 的版本，同步修改 `apps/desktop/package.json`、`apps/desktop/package-lock.json`、`apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/tauri.conf.json` 和 `Cargo.lock` 中的桌面包版本。
- 合入 `main` 并完成 CI 后，由仓库所有者推送与应用版本一致的 `v<version>` 标签，触发 `.github/workflows/release.yml`。
- 不要批量推送上游历史标签来触发发布。

## 待处理的问题

- 补充 Remote SSH、语音输入 HTTP/2 透传的真实客户端验证；未确认项见排查记录。
- 对 Cursor 聊天中的 Windows 本地文件链接进行规范化。已观察到部分 Cursor 版本会移除裸盘符 Markdown 链接的 `href`，而 Canvas 文件可通过原生入口打开。
- 跟进 Cursor 协议变化，并用真实客户端验证工具调用、取消、会话恢复及 Canvas 接入。

具体需求和修复在本仓库 [Issues](https://github.com/Quiyyy/cursor-byok/issues) 中跟踪。报告问题时只提供脱敏日志和最小复现，不提交数据库、账号文件、API Key 或 OAuth 凭据。
