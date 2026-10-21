# Cursor 原生运行时维护

生产路径从本机已安装的 Cursor 加载模型工厂和工具实现。`server/cursor-runtime/` 是 IPC bridge，不分发 Cursor bundle；`support/cursor-assets-extractor/` 保留结构定位、受限加载和固定测试样本生成工具。

```text
support/cursor-assets-extractor/
├── locate.mjs        # AST 结构定位；不依赖压缩变量名或固定偏移
├── loader.mjs        # 跳过扩展激活；运行阶段仅额外允许本机命令解析库
├── extract.mjs       # 生成固定协议回归夹具，记录来源指纹
├── render.mjs        # 固定中性配置用于确定性回归，不是生产模型适配
└── verify-native/    # 使用生产路由与原生 worker 的隔离验证服务

server/
├── cursor-runtime/   # 生产模型配置、工具会话、流与 Node IPC
├── src/cursor/native/ # Rust 进程、Run 租约及 Cursor transport 绑定
├── prompt/cursor/    # 每轮上下文、模式提醒、压缩提示与 BYOK 自有工具
└── tests/fixtures/cursor/ # 固定提示词/工具与模式清单，仅用于回归
```

## 安装位置与更新

默认寻找 Windows 的 `%LOCALAPPDATA%/Programs/cursor/resources/app`、macOS 的 `/Applications/Cursor.app/Contents/Resources/app`、Linux 的 `/opt/Cursor/resources/app`。其他安装位置使用 `CURSOR_APP_DIR` 指向真实的 `resources/app`。worker 默认使用该安装自带的 Cursor 可执行程序，以 `ELECTRON_RUN_AS_NODE=1` 启动，避免原生命令解析模块的 ABI 不一致。`CURSOR_NODE_EXECUTABLE` 仅用于显式指定兼容执行程序。

每个新 Run 检查 bundle 与产品元数据的修改时间、文件大小；变化后创建新 worker。正在执行的 Run 继续持有原 worker，旧会话下一轮使用新工厂，历史消息不重写。日志记录 Cursor version、commit 和 bundle SHA-256。工厂定位失败、运行时缺失或异常退出会显式失败；生产路径没有静态协议回退。

本机验证基线为 Cursor **3.25.6**，commit `f0df777c412b670d09e3eaf214967d779e67c080`。跨版本结构定位、macOS/Linux、Remote SSH 需要独立验收。当前使用本地工厂与其默认模型信息，不包含 Cursor 云端实验配置，不承诺所有模型与云端行为完全相同。

加载器在独立进程中读取已安装的可信 Cursor 文件；Node `vm` 不是操作系统安全沙箱。工具产生的文件、终端、子任务和交互操作经原生 protobuf 回到 Cursor 客户端。它不会激活扩展入口，或通过 worker 直接读写项目文件、启动命令、访问网络。WebSearch/WebFetch 通过宿主已有服务处理；未提供图像执行服务，因此不发布 GenerateImage。

## 构建与验证

```sh
npm --prefix apps/desktop ci
node server/cursor-runtime/build.mjs
node server/cursor-runtime/build.mjs --check
node --test server/cursor-runtime/runtime.test.mjs support/cursor-assets-extractor/locate.test.mjs
cargo test -p cursor-server --lib --tests
cargo clippy -p cursor-server --all-targets -- -D warnings
cargo fmt --all -- --check
```

`worker.bundle.mjs` 是需提交的生成产物，包含 bridge 与 Babel 依赖，构建保留 legal comments。Rust 直接嵌入它；CI 校验源码与产物一致。未设置 `CURSOR_APP_DIR` 时，Node 测试跳过安装相关用例，其余回归不需要 Cursor。

Windows 本机原生验证（先设置实际安装目录）：

```powershell
$env:CURSOR_APP_DIR = "$env:LOCALAPPDATA/Programs/cursor/resources/app"
node server/cursor-runtime/test-installed.mjs
cargo test -p cursor-server --lib installed_worker_generates_native_profiles_over_ipc -- --ignored
cargo test -p cursor-server --test native_runtime -- --ignored
```

这些用例分别检查官方模型工厂、StrReplace/Notebook/ApplyPatch、原生锁、取消、拒绝、Todo 恢复、交互与图片；Rust 用例覆盖实际 worker IPC、Cursor protobuf 回调、checkpoint 提交与模型续轮。原生客户端 UI 的真实模型验证单独进行，不与模拟客户端测试混称。

## 真实 Cursor 验证服务

`verify-native` 复用生产 Router、PromptCompiler、TransportRegistry、RunEngine 和工具桥接，使用独立数据库、已有受信任 CA 与已授权的模型网关。它不安装证书、不打开正式应用接管，也不修改日常 Cursor 设置。

环境变量：`CURSOR_BYOK_DATA_DIR`（隔离目录）、`CURSOR_APP_DIR`、`CHECK_NATIVE_MODEL`（生成官方模型配置所用的真实模型 ID）、`CHECK_MODEL`（网关路由 ID）、`CHECK_GATEWAY_URL`、`CHECK_GATEWAY_KEY`、`CHECK_CA_DIR`。密钥只通过子进程环境传入，不能放进命令行或仓库。

```sh
cargo run -p cursor-protocol-native-check
```

启动后从测试目录 `connection.json` 读取代理地址，为隔离 Cursor 的用户数据目录和测试工作区配置。账号认证和隐私选择遵循原生流程。验证结束关闭隔离窗口与服务、恢复临时网关设置，并清除隔离配置中的认证数据。

## 固定夹具更新

固定夹具用于没有 Cursor 安装的 CI 测试消息、checkpoint、提供商协议和模板。它不控制生产工具选择，也不参与失败回退。

```powershell
node support/cursor-assets-extractor/extract.mjs `
  --cursor-app "$env:CURSOR_APP_DIR" `
  --output server/tests/fixtures/cursor/protocol.json
```

夹具保留来源 version、commit、SHA-256，重复提取应字节一致。`CURSOR_PROTOCOL_FILE` 已从应用启动移除；不再通过替换 JSON 文件更新生产工具。
