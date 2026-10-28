# 自动化验收

本文记录当前测试入口及证据范围，不定义新的产品规范。普通 CI 无需 Cursor 安装、正式账号或付费模型；依赖安装完成后，新增验收用例只使用本地进程与回环网络。

## 能力与测试对应

| 能力 | 测试入口 | 证明范围 |
| --- | --- | --- |
| 原生网关鉴权、接管开关、同名配置隔离 | `server/src/local_app/native_agent/tests.rs` | 生产路由、真实 Store 和 HTTP 上游；原生密钥与 External API 独立，实际请求进入选中的连接 |
| 原生参数、身份及调用记录 | 同上 | 直接转发与协议转换均保留显式参数、原生会话和运行身份；配置模板使用会话 ID，内部头不透传 |
| 上下文容量、重置、协议参数转换 | 上述原生用例及 `server/tests/external_api.rs` | 复用已有容量和协议矩阵，不在每个入口重复整套组合 |
| 直接 API 取消 | `disconnecting_native_stream_closes_upstream_and_allows_the_next_run` | 真实 HTTP 客户端断流后，上游连接关闭、调用记录终结；下一运行正常。覆盖直接和转换两条路径 |
| 插件取消 | `plugin::registry::tests::cancellation_reaches_the_worker_without_cancelling_the_next_invocation` | 丢弃网关响应后，真实 Deno worker 收到取消；下一调用独立，记录不残留 running |
| 插件网络取消 | `plugin::worker::network::tests::cancelling_plugin_network_closes_a_connection_waiting_for_tls` | 等待 TLS 响应时取消实际 socket；不安装测试 CA、不放宽 HTTPS 校验。流式响应由直接 API 用例覆盖，不能据此宣称插件所有网络阶段均已覆盖 |
| 鉴权重试 | `plugin::registry::tests::worker_auth_retry_uses_persisted_credentials_and_never_replays_partial_output` | 真实 Deno worker 首次拒绝凭据、持久化刷新、重试成功；已经输出后不重试；各次调用记录独立 |
| 重试记录详情和并发凭据刷新 | 既有 `plugin::worker::network::tests`、`plugin::registry::tests` | 复用详细/普通日志、并发刷新及取消后凭据落盘回归 |
| 设置刷新、默认模型、上下文交互 | `apps/desktop/tests/ui/settings.spec.mjs` | 生产前端与真实 Rust 管理服务；实际点击、保存、重新加载后核对界面及持久化数据 |
| 功能失败隔离 | `apps/desktop/tests/state.test.mjs` | 复用已有状态测试，页面测试只补交互接线与真实服务闭环 |
| 子任务、搜索、Steer、新对话入口 | `server/native-agent/*.test.mjs` | 接入模块与合成私有边界的契约；不等于真实 Cursor 执行器验收 |

网关测试只设置隔离数据库中的接管状态，以测试鉴权和模型路由，不执行系统接管。页面测试只对初始目录 GET 注入 503；恢复后的读取、保存及持久化均使用真实服务。插件重试使用本地测试插件返回认证错误，不代表真实服务商授权测试。

## 运行

现有 Rust、Node、Deno、状态及构建检查见[维护指南](../MAINTAINING.md#检查)。插件 worker 用例沿用 `DENO_TEST_EXECUTABLE` 和 `--include-ignored` 专项步骤；未执行该步骤不能计为通过。

页面测试在仓库根目录准备前端与服务：

```sh
npm --prefix apps/desktop ci
npm --prefix apps/desktop run check
cargo build --locked --package cursor-server --bin cursor-server
```

再进入 `apps/desktop`：

```sh
npx playwright install chromium
npm run test:ui
```

测试读取仓库 `target/debug/cursor-server`（Windows 为 `.exe`）；设置 `CARGO_TARGET_DIR` 时使用其绝对路径。每个页面用例启动独立服务、临时数据目录和随机端口，页面与 API 同源；结束后关闭进程并删除临时数据。

[CI](../.github/workflows/ci.yml) 的 Linux Rust job 构建服务，Frontend job 复用该产物与自己的生产前端构建执行 Chromium 测试。失败时上传 `target/ui-tests/` 中的报告、截图、trace 和服务日志。用例不自动重试；时序测试等待事件并设置超时。

## 剩余验收边界

CI 通过不能证明某个 Cursor/Harness 版本的入口仍然兼容，也不能证明真实菜单、原生 Task、Steer 步骤消费、工具审批和搜索卡片正确。接入代码或 Cursor/Harness 版本变化时，针对受影响的原生行为验收；账号适配变化时，针对对应的真实服务通道验收。普通配置、协议及管理页面改动由相关自动化用例覆盖后，不机械重复整份人工清单。
