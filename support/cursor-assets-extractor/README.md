# Cursor 内置协议提取

从已安装 Cursor 的 `cursor-local-agent-runtime` 提取统一的 IDE 基础提示词和内置工具 JSON Schema。所有模型使用同一协议；模式只决定工具可用范围，不维护模型家族分支。MCP 的定义、连接与执行归 Cursor，本工具不导出 MCP 目录。

```text
support/cursor-assets-extractor/
├── extract.mjs       # 校验、来源记录与原子写入
├── locate.mjs        # 用 AST 结构定位工厂，避免依赖压缩变量名和文件偏移
├── loader.mjs        # 加载工厂，禁用扩展入口及提取期间的工具执行
├── render.mjs        # 固定 IDE 配置，生成一份与服务商无关的协议
└── verify-native/    # 隔离的真实 Cursor 验证服务，不改正式应用的接管设置

server/prompt/cursor/
├── protocol.json     # 生成资产：来源、统一提示词、17 个内置工具
├── extensions.json   # BYOK 自有工具：Semble 与子任务进度
├── modes/*.json      # 各模式的工具可用范围
├── */runtime.md      # 每轮动态上下文与模式提醒
└── compaction/prompt.md # BYOK 自己执行的会话压缩指令
```

## 同步资产

先安装 `apps/desktop` 的开发依赖。本工具复用其中的 Babel parser/traverse，不安装或启动 Cursor 扩展。

```powershell
node support/cursor-assets-extractor/extract.mjs `
  --cursor-app "$env:LOCALAPPDATA/Programs/cursor/resources/app" `
  --output server/prompt/cursor/protocol.json
```

`--cursor-app` 必须是本机 Cursor 的 `resources/app`，不是任意下载的脚本目录。提取使用已安装客户端的工厂代码；Node `vm` 不是操作系统沙箱。工厂只在受限加载器中生成文本和 Schema，不调用官方工具执行器，也不修改 Cursor 安装文件。

当前提取配置为 `agentType=ide`、`vendor=unknown`、`promptVersion=cursor-0226`，用中性身份替代特定模型身份，关闭 MCP 目录生成。它是一份明确的统一配置，不代表 Cursor 云端每个模型、每组实验开关的完整提示词。`protocol.json` 记录版本、commit 和源 bundle SHA-256，重复生成必须字节一致。

协议清单覆盖目前 BYOK 可执行的 IDE 内置工具：文件读写/替换/删除、Glob、Grep、终端、Notebook、诊断、待办、任务、计划、模式切换、问题表单、WebSearch、WebFetch 与 GenerateImage。新增工具或执行语义变化必须同步适配 Rust 执行层并通过合同测试；不会把无法执行的工厂工具静默发布给模型。

提取失败不会覆盖现有文件。正常发行使用仓库内嵌资产；本地验证可指定独立文件：

```powershell
$env:CURSOR_PROTOCOL_FILE = 'D:/absolute/path/protocol.json'
cargo run -p cursor-server
```

外部资产在每轮开始时读取并完整校验，一轮内部使用固定快照。旧会话下一轮直接使用新提示词和工具定义，原有消息不重写；系统前缀更新可能使提供商重新计算前缀缓存。损坏或不完整的文件会报错，不静默使用旧文件。当前同步由此命令触发，不在后台自动运行提取器。

## 验证

```sh
node --test support/cursor-assets-extractor/locate.test.mjs
cargo test -p cursor-server --test cursor_protocol_assets --test cursor_protocol_update --test cursor_builtin_contract
cargo test -p cursor-server --test prefix_stability --test checkpoint_recovery --test tool_round --test compaction
cargo test -p cursor-server --lib
```

`verify-native` 是开发验证入口，复用生产 Router、PromptCompiler、TransportRegistry、RunEngine 和工具适配。它使用独立数据库、已有受信任 CA 和已授权的本地模型网关，不安装证书、不启用正式应用接管、不修改日常 Cursor 设置。通过隔离 Cursor 的用户数据目录与测试工作区操作，模型请求只写到该测试目录。

所需环境变量：`CURSOR_BYOK_DATA_DIR`（新建测试目录）、`CURSOR_PROTOCOL_FILE`、`CHECK_MODEL`、`CHECK_GATEWAY_URL`、`CHECK_GATEWAY_KEY`、`CHECK_CA_DIR`。密钥仅经子进程环境传入，勿放在命令行或提交到仓库。启动后从测试目录 `connection.json` 获取代理地址，将其配置到隔离 Cursor。认证和首次启动的隐私选择使用 Cursor 原生流程。

```sh
cargo run --manifest-path support/cursor-assets-extractor/verify-native/Cargo.toml
```

验证结束关闭隔离窗口与服务，撤销临时网关配置。该服务不供日常使用，不能代替正式应用的生命周期管理。
