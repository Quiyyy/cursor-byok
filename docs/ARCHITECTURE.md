# 当前架构

本说明对应仓库当前目录，覆盖桌面入口、请求执行、状态持久化与扩展边界。运行时提示模板是程序输入，位于 `server/prompt/`。

## 目录职责

```text
cursor-byok/
├── apps/desktop/                     # 桌面应用
│   ├── src/
│   │   ├── index.tsx                 # 前端启动与基础能力装配
│   │   ├── App.tsx                   # 路由组合入口
│   │   ├── shell/                    # 窗口框架、导航与页面布局
│   │   ├── features/
│   │   │   ├── cursor/               # 全局接管开关与证书准备
│   │   │   ├── home/                 # 指标、趋势图与年度活动
│   │   │   ├── models/               # API 模型配置与连通性测试
│   │   │   ├── plugins/              # 账号授权、资源与模型目录管理
│   │   │   ├── calls/                # 调用列表与详情
│   │   │   └── settings/             # 应用与服务设置
│   │   ├── shared/                   # API 客户端、状态、UI 与平台能力
│   │   ├── demo/                     # 仅使用内存示例数据的产品演示
│   │   ├── i18n/                     # 翻译目录与语言选择
│   │   └── styles/                   # 主题和字号令牌
│   └── src-tauri/
│       ├── src/                      # 生命周期、托盘、更新与前端资源服务
│       └── icons/                    # 应用图标源文件与平台产物
├── server/
│   ├── src/
│   │   ├── app.rs                    # 依赖装配、路由组合与服务启动
│   │   ├── config.rs                 # 环境配置与数据目录
│   │   ├── api/                      # Cursor 协议入口与 External API
│   │   ├── control/                  # 桌面管理 HTTP API
│   │   ├── local_app/                # Cursor 本地代理、证书与设置管理
│   │   ├── cursor/                   # Cursor 协议、提示编译、transport 与服务适配
│   │   ├── run/                      # 模型调用、工具轮次、重试与压缩执行
│   │   ├── model/                    # 通用领域类型与消息契约
│   │   ├── provider/                 # 模型协议适配与调用路由
│   │   ├── plugin/                   # 插件宿主、账号管理、OAuth 与 TypeScript SDK
│   │   ├── store/                    # SQLite 持久化与事务
│   │   └── search/                   # 搜索接入与缓存
│   ├── plugins/build-in/             # 随应用交付的账号接入插件
│   ├── cursor-runtime/               # 安装于本机的 Cursor 原生工厂与工具桥接
│   ├── prompt/                       # 每轮上下文、压缩与提交信息模板
│   └── migrations/                   # SQLite 迁移
├── crates/semble-core/               # 本地代码索引与混合搜索
├── protocols/cursor/                 # Cursor 协议定义
├── support/                          # 协议提取、抓包与基准测试工具
├── docs/                             # 使用、架构、维护状态与资产文档
├── images/                           # README 的演示截图
└── .github/                          # CI 与正式发布工作流
```

## 启动与管理路径

```text
桌面入口 / 独立服务入口
        │
        ▼
Config → App::new → Store + PluginRuntime + ProviderRouter
        │             + TransportRegistry + CursorHarness
        ▼
Rust HTTP 服务（桌面模式绑定本机地址）
        ├─ /__byok-api__/        → WebView 前端资源
        └─ /__byok-api__/api/*   → control → Store / 插件 / 本地接管
```

桌面 WebView 与管理 API 使用同一个 Rust 服务来源。开发时 Rust 将前端资源请求代理到 Vite，业务 API 仍由 Rust 处理。Tauri 命令只承担剪贴板、窗口、终端等原生能力。

TAB 默认由本地代理沿 Cursor 官方路径透传；只有选择自定义服务时，相关请求才交给 `cursor/services/tab.rs` 转发至用户填写的地址。TAB 路由与 BYOK 聊天模型配置相互独立。

## 一次模型请求

```text
Cursor 请求、客户端工具结果
        │
        ▼
local_app 本地代理
        ├─ 官方路径 → Cursor 官方服务
        └─ 本地路径 → api/cursor → cursor/transport
                                      │
                           提示编译、消息规范化、会话定位
                                      ▼
                                  run 引擎
                         ┌────────────┴─────────────┐
                         ▼                          ▼
                    provider                   plugin 宿主
                         │                          │
                  兼容协议 API                Deno 插件 / SDK
                         └────────────┬─────────────┘
                                      ▼
                             模型事件 / 工具请求
                                      │
                           Cursor 工具执行 → 结果返回
                                      │
                          下一模型轮次或结束本次 Run
                                      ▼
                          Store 检查点、调用与用量记录
                                      │
                          transport 输出 Cursor 事件
```

接入协议负责将客户端请求转换为通用消息和命令；`run/` 驱动模型与工具轮次；`provider/` 和 `plugin/` 负责服务商差异。外部服务返回结果不会直接绕过运行时写入客户端会话。

内置提示词、工具 Schema、参数解析和工具算法来自本机已安装 Cursor 的原生工厂。统一协议负责承载它们；不同模型的提示词、工具名、参数格式由同一套官方工厂生成。BYOK 保留模型循环、提供商适配、checkpoint、自有扩展，以及 Ask 模式的只读工具范围。MCP 定义来自客户端请求，连接及执行仍归 Cursor。

```text
server/
├── cursor-runtime/                   # Node worker；只加载本机 Cursor，不分发 Cursor bundle
│   ├── runtime.mjs                   # 按 AST 结构定位原生工厂与 protobuf 类型
│   ├── profile.mjs                   # 用实际模型 ID 和模式生成原生提示词、工具契约
│   ├── session.mjs                   # 原生工具会话、状态容器与执行闸门
│   ├── worker.mjs                    # JSON-lines IPC 与客户端回调关联
│   ├── queue.mjs                     # 工具参数和执行结果的异步队列
│   ├── build.mjs                     # 生成或校验可嵌入的 worker
│   └── worker.bundle.mjs             # 生成产物：本项目 bridge 与构建依赖
├── src/cursor/native/
│   ├── mod.rs                        # 安装位置、版本变化与 worker 租约
│   ├── process.rs                    # 进程健康、IPC、请求超时与异常退出
│   ├── session.rs                    # 每个 Run 的配置、调用身份和取消
│   └── bridge.rs                     # 原生 Exec/Interaction ↔ 当前 Cursor transport
├── src/cursor/checkpoint/native.rs   # 从 checkpoint 恢复状态；按已完成工具卡片持久化
├── src/provider/text_tools.rs        # 将原生文本工具承载到仅支持 JSON function 的接口
├── prompt/cursor/                    # 每轮上下文模板、压缩提示与 BYOK 自有工具
└── tests/fixtures/cursor/            # 固定协议快照与模式清单；仅用于确定性回归测试
```

```text
用户请求 + Cursor checkpoint
  → 还原 canonical history（不重写历史）
  → 为本次 Run 获取 worker 租约 → 官方模型工厂 → PromptSpec
  → BYOK RunEngine → provider / 账号插件 → 模型
  ← 文本、工具名、JSON 参数或原生文本输入
  → 官方工具参数解析 / ToolSession / 文件锁 / 编辑算法
  → 官方 remoteImplementation → Exec / Interaction protobuf
  → 当前 Cursor transport → 客户端权限流程、文件/终端/子任务执行器
  ← 原生客户端结果 → 官方 renderer → canonical ToolResult
  → checkpoint 提交屏障 → 工具完成事件 → 下一模型轮次
```

参数流可以产生预览；实际 Exec、交互请求在模型轮次通过执行闸门后才发送。客户端拒绝仍是拒绝，不由 bridge 自动批准。Todo、计划、已读路径和子任务标识从现有 checkpoint 恢复，状态以已完成原生卡片投影回 checkpoint。

每轮开始检查本机 Cursor bundle 和产品元数据。Cursor 更新后，新 Run 获取新 worker，旧会话可以直接采用新提示词；已经运行的 Run 持有原 worker，直到完成或取消。worker 退出会使关联 Run 失败，下一 Run 重建进程，不静默退回旧的手写工具实现。

已删除 `cursor/tools/edit.rs`、`schedule.rs` 和 `tool_call_dispatch/edit.rs` 及隐藏读写阶段。文件替换、Notebook 编辑、diff 和同文件排队由原生工具承担。静态协议构造器只服务回归夹具；应用启动固定使用 `PromptCompiler::native`，不读取 `CURSOR_PROTOCOL_FILE`。

OpenAI Responses 保留原生 custom tool / grammar；只支持 JSON function 的 Chat、Anthropic 和插件接口使用 `{input: string}` 承载原始文本，返回时还原，canonical history 不改写。JSON 接口不具备 Responses 服务端语法约束能力，最终仍由原生工具解析器校验。

当前验证基线是 Windows Cursor 3.25.6。模型匹配来自本地工厂，尚不包含云端实验开关；不能宣称与每个官方模型的云端行为完全一致。WebSearch/WebFetch 沿用 BYOK 服务，GenerateImage 因没有图像执行服务而不对模型发布。跨版本、macOS/Linux、Remote SSH 和在途子任务进程重启恢复仍需独立验收。

构建与验证步骤见[原生运行时维护](../support/cursor-assets-extractor/README.md)。

## 状态与生命周期

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 表单草稿、展开状态、弹窗 | 前端组件 | 当前编辑过程；保存后交给管理 API |
| 模型、设置、调用记录、会话检查点 | `store/` | 持久化到 SQLite，可跨启动加载 |
| 插件资源与续期凭据 | `plugin/` | 账号级管理；续期结果先持久化再继续请求 |
| 模型与工具执行、取消信号 | `run/` | 一次 Run 的活动执行过程 |
| Cursor 请求关联和事件输出 | `cursor/transport/` | 当前连接、请求与会话的传输关系 |
| 本地代理、CA 与 Cursor 设置 | `local_app/` | 应用接管状态 |

模型重试或工具结果回传属于当前 Run 的推进，不应被当作新的对话；新请求与恢复流程通过会话和检查点定位已有状态。进程重启后的在途子任务恢复仍需单独验收，不能仅凭持久化检查点宣称已覆盖。

## 扩展入口

- 新服务商协议：`server/src/provider/`。
- 账号登录、资源与模型发现：`server/plugins/build-in/` 和 `server/src/plugin/sdk/`。
- Cursor 协议变化：`protocols/cursor/`、`server/src/cursor/`。
- 桌面管理功能：`apps/desktop/src/features/` 与 `server/src/control/`。
- 搜索能力：`server/src/search/` 与 `crates/semble-core/`。

架构变更需要同步更新目录职责与完整请求路径；不要保留已删除目录的兼容说明。
