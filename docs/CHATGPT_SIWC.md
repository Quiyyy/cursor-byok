# ChatGPT 官方授权连接

`ChatGPT (SIWC)` 使用 OpenAI 的 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) 授权此应用使用符合条件的 ChatGPT 计划。它是独立账号连接，不读取、修改或替代现有 Codex 凭据，也不调用 Codex CLI。

## 使用

在“账号连接”中打开 `ChatGPT (SIWC)`，点击“继续使用 ChatGPT”，在系统浏览器完成授权。浏览器与 BYOK 运行在同一台机器，本地回调绑定 `127.0.0.1` 的随机端口。登录资格和计划权限由 OpenAI 决定，Codex 通道可用不代表该授权一定可用。

首次授权创建注册记录；以后在授权账号下拉框选择已保存的记录，可以重新授权或切换到该账号。只有成功校验身份和计划权限后，才切换当前账号并同步其模型目录。新登录失败不替换原先的当前账号。未完成授权的注册也保留，重试时选择它即可复用已签发的客户端身份。

账号的“管理用量”打开 ChatGPT 的用量管理页。“断开 ChatGPT 授权”撤销可续期会话并清除本地令牌，保留注册信息供以后登录；无法确认远端撤销时会明确提示。“移除账号”则删除本地注册记录。退出授权后，不自动选择另一账号或切换到 API Key 计费。

## 边界

```text
账号页面 → 宿主管理回调、PKCE、安装身份与注册持久化
         → 插件校验 OpenAI ID token、授权范围并维护令牌
         → api.openai.com/v1/models（当前账号目录）

Cursor 原生 Agent → 原生 Responses 网关 → SIWC 插件
                 → api.openai.com/v1/responses
                 ← Responses 事件 → Cursor 原生工具循环
```

Cursor 仍负责工具、会话、Subagent、审批和停止。SIWC 的 HTTP 模型入口只接受 Responses；管理页面模型测试与 Commit 生成继续使用现有 Provider 接口。

插件采用 `store:false`、`stream:true`，必须收到 `response.completed` 才视为成功。普通函数/custom 工具被分组到传输命名空间，返回事件还原原有工具名和身份；签名推理项保持原样，普通追加历史保持前缀稳定。搜索辅助请求使用同一公开 Responses 接口，将 Cursor 的 `web_search_preview` 名称映射为 `web_search`。完成事件省略结果列表时，使用同一响应内已收到的完成项补齐，不把未完成的流当作成功。

按[官方预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)，`max_output_tokens` 等不支持的请求参数和工具会明确失败。不暴露未经真实账号验证的 Fast 菜单能力。显式 `service_tier` 可以透传，但上游是否接受仍取决于账号和服务能力。图像生成、托管 MCP、Code Interpreter、`tool_search` 等不属于此连接的支持范围；Cursor 自己执行的本地工具/MCP 不等同于上游托管工具。

## 验证

```sh
deno test --config server/plugins/build-in/chatgpt-auth/deno.json server/plugins/build-in/chatgpt-auth/
cargo test --package cursor-server --lib plugin:: -- --include-ignored
npm --prefix apps/desktop run test:ui
```

Rust 插件测试需要 `DENO_TEST_EXECUTABLE`。隔离用例覆盖注册与重试、身份及权限校验、刷新、退出、真实 Deno worker 经本地 HTTPS 上游的工具/签名回放、请求身份、搜索引用、取消后新请求，以及账号界面的选择与取消。网络替身仅控制 OpenAI 上游，不使用正式凭据或修改系统证书。

这些结果不代替真实 SIWC 账号授权、实际服务商能力或完整 Cursor UI 验收。在完成这些验证前，保留现有 Codex 通道。

2026-10-29 的 Windows 隔离实例已完成真实浏览器授权，并读取到 8 个账号模型。`gpt-6.1-sol` 的文本测试、`auto`/`required` 函数与 custom 工具往返、加密推理回放、搜索引用、取消后再次请求，以及令牌轮换后继续调用均通过。刷新保持原注册与安装身份，测试未使用现有 Codex 凭据。

同次实测中，按函数名称指定 `tool_choice` 的命名空间请求被上游以 HTTP 400 拒绝；连接保留调用方选择并报告原始参数错误，不静默改成其他选择方式。实际 Cursor 3.27.22 文件副本的安装恢复、模型目录序列化与客户端构造通过；完整 Cursor UI 操作和实际 Subagent 调度尚未在新连接上整体验收。
