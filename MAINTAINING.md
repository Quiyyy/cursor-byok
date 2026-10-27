# 维护与开发

本项目由 [Quiyyy/cursor-byok](https://github.com/Quiyyy/cursor-byok) 的维护团队持续开发。`origin`、问题反馈、文档和发布资产均以本仓库为准，日常开发从 `main` 创建 `codex/` 分支。

先阅读 [AGENTS.md](./AGENTS.md)。产品使用见[使用指南](./docs/GETTING_STARTED.md)，模块职责见[架构说明](./docs/ARCHITECTURE.md)，修复范围见[维护状态](./docs/MAINTENANCE_STATUS.md)。

## Agent 维护规范

`AGENTS.md` 只声明核心设计、维护约束与规范路由；实现现状和操作步骤分别见架构说明与本文。每次提交前，按顶层规范完成实现与规范的一致性自检，并确认规范之间没有矛盾。

## 环境与启动

- Rust stable、Cargo、rustfmt 和 Clippy。
- Node.js 22 或更新的兼容版本，以及 npm。
- 运行 BYOK Agent 需要本机 Cursor 安装。非默认路径设置 `CURSOR_APP_DIR`；原生入口安装、恢复与本机验证见[维护说明](./server/native-agent/README.md)。
- Tauri 2 对应平台的构建依赖；Windows 使用 MSVC 工具链，Linux 依赖可参照 [CI](./.github/workflows/ci.yml) 的安装步骤。
- Deno 2.9.6 用于插件开发和测试。普通用户可通过应用准备插件运行组件。

开发前可按下方隔离调试说明设置独立数据目录，避免读取日常使用的账号与数据库。

```sh
npm --prefix apps/desktop ci
npm --prefix apps/desktop run dev:web
```

`dev:web` 同时启动 Rust 服务与 Vite。浏览器应访问 Rust 管理服务的 `/__byok-api__/`，开发脚本使用 `http://127.0.0.1:3000/__byok-api__/`；不要把独立 Vite 地址当作管理 API 的来源。

桌面开发：

```sh
npm --prefix apps/desktop run tauri:dev
```

`make dev-web`、`make dev-desktop` 是对应快捷入口。独立服务入口为 `server/src/bin/cursor-server.rs`，前端构建后可用 `make dev-server` 启动。

## 检查

```sh
npm --prefix apps/desktop run check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
node server/native-agent/build.mjs --check
node --test server/native-agent/*.test.mjs
deno test --config server/plugins/build-in/grok-auth/deno.json server/plugins/build-in/grok-auth/
deno test --config server/plugins/build-in/codex-auth/deno.json server/plugins/build-in/codex-auth/
deno test --config server/plugins/build-in/antigravity-auth/deno.json server/plugins/build-in/antigravity-auth/
deno test --import-map server/src/plugin/sdk/import-map.json server/src/plugin/sdk/oauth_test.ts
```

宿主凭据测试需将 `DENO_TEST_EXECUTABLE` 设置为 Deno 可执行文件路径，再运行：

```sh
cargo test --package cursor-server --lib plugin:: -- --include-ignored
```

集成测试使用临时目录中的 `PluginRuntime::in_directory` 与 `PluginRegistry::in_directory`；不要调用会读取正式账号目录的 `managed()`。基准测试有独立的[运行说明](./support/benchmarks/semble/README.md)。

CI 包含前端类型与生产构建检查、Linux Rust 检查和测试、Windows/macOS 桌面 Rust 检查，以及插件凭据生命周期测试。

## 本地打包与 UI 调试

只编译桌面程序：

```sh
npm --prefix apps/desktop run tauri:build -- --debug --no-bundle
```

完整本地安装包可使用 `make build-desktop`。该命令生成独立本地签名密钥；它不代表正式发布签名。

`CURSOR_BYOK_DATA_DIR` 可指定绝对路径，将数据库、插件、日志和缓存放入独立目录。未设置时使用用户目录下的 `.cursor-byok-v3`。调试使用新建目录与示例数据，不复制正式账号凭据。

Windows 上与安装版同时运行时，创建临时配置，例如：

```json
{
  "identifier": "dev.cursorbyok.desktop.ui-debug",
  "bundle": { "createUpdaterArtifacts": false }
}
```

```sh
npm --prefix apps/desktop run tauri:build -- --debug --bundles nsis --config <临时配置的绝对路径>
```

启动调试程序时，仅在子进程环境中设置 `CURSOR_BYOK_DATA_DIR`，同时将 `APPDATA` 指向独立临时目录，隔离 Cursor 设置。UI 回归使用模拟接管接口，不自动开启真实接管、安装证书或导入正式凭据。

临时标识、签名覆盖、数据库和安装包不提交到仓库。正式 `tauri.conf.json` 保持实际应用标识与更新配置。

截图采用纯前端演示模式，生成步骤见[资产说明](./docs/ASSETS.md)；不需要启动真实账号或模型服务。

## 提交与发布

1. 从当前 `main` 创建分支，保持一个 PR 的变更范围明确。
2. 更新相关文档与本地化，运行对应检查后提交 PR。
3. 等待 CI 通过后合入 `main`。
4. **只有维护者明确要求发布时**，才更新版本、准备发布提交并推送匹配标签。普通合入不触发 Release。

发布入口为 [.github/workflows/release.yml](./.github/workflows/release.yml)，操作规范见 [release 技能](./.agents/skills/release/SKILL.md)。

- 应用版本在 `apps/desktop/package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 和根目录 `Cargo.lock` 中保持一致。
- 发布标签采用 `v<version>`，必须指向已包含在 `origin/main` 中的提交。
- 工作流只响应版本标签，并检查发起账号与当前仓库所有者一致。
- Tauri 更新使用 `latest.json`；Windows 便携更新使用 `portable-latest.json`。当前工作流还生成 `update.json` 供既有客户端使用，移除它应作为单独的更新策略变更。
- 更新签名私钥通过 GitHub Actions secrets 提供，不能提交或打印；资产来源和打包格式见[资产说明](./docs/ASSETS.md)。

## 文档维护

- README 介绍产品、下载和当前使用路径，不记录个人宣传或临时开发过程。
- 使用指南与 UI 标签保持一致；源码截图明确标注演示数据，不承诺尚未发布的版本行为。
- 架构说明只写当前存在的目录；Commit 提示文件 `server/prompt/cursor/commit/` 属于程序资源，不作为普通说明文档批量修改。
- 修复结论关联可验证代码、测试或本仓库 PR；未验证的行为保留为待验收项。
- 图标、字体和第三方代码遵循各自许可，保留 [LICENSE](./LICENSE) 和必要来源记录。
