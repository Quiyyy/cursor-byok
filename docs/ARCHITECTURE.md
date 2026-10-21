# 当前架构

Cursor BYOK 是模型网关与桌面管理器。当前源码在 Cursor 已初始化的 Agent Host 中选择完整的原生 `LocalAgentClient`，提示词、工具、执行循环和会话状态均由安装在本机的 Cursor 实现。

## 目录职责

```text
apps/desktop/
├── src/                         # 模型、账号、调用记录、设置与接管开关
└── src-tauri/                   # 桌面生命周期、托盘、更新与资源服务
server/
├── native-agent/
│   ├── patch.mjs                # 定位原生入口，注入模型路由与工厂导出
│   ├── route.cjs                # 在原 Agent Host 内选择真实模型与本地网关
│   ├── install.mjs              # 安装、备份、还原与原生模型目录生成
│   ├── native.test.mjs          # 路由、所有权与安装恢复回归
│   ├── build.mjs                # 打包安装工具及依赖许可
│   └── install.bundle.mjs       # 生成产物；不包含 Cursor 源码
├── src/
│   ├── app.rs                   # 依赖装配、路由与服务生命周期
│   ├── local_app/               # 原生入口安装、代理、CA 与 Cursor 设置
│   ├── api/byok/                # 原生模型网关和独立的 External API
│   ├── api/cursor/              # 模型目录、账户展示及服务 RPC
│   ├── cursor/services/         # 原生目录封装、TAB、Commit 与账户响应
│   ├── cursor/protocol/         # Connect 帧及 Commit 等少量服务记录
│   ├── provider/                # 模型协议、请求记录与流式转发
│   ├── plugin/                  # 账号、授权续期、Deno 宿主及 SDK
│   ├── model/                   # 模型配置、HTTP 消息与用量类型
│   ├── store/                   # 配置、用量和诊断的 SQLite 存储
│   └── control/                 # 桌面管理 API
├── plugins/build-in/            # 内置账号连接插件
├── prompt/cursor/commit/        # 独立 Commit 功能的中英文提示词
└── migrations/                  # 已应用的数据库结构历史
crates/semble-core/              # 独立搜索研究库；应用已不依赖它
support/benchmarks/semble/       # 搜索基准；不参与 Agent 执行
```

## 启动与接管

```text
Tauri / 独立服务
  → Store + PluginRuntime + ProviderRouter + CursorHarness
  → 本机 HTTP 服务
      ├─ /__byok-api__/api/*        → 桌面配置与统计
      ├─ /__byok-native__/models/*  → 原生 Agent 专用模型网关
      └─ /byok/v1/*                 → 可单独启停的 External API

开启接管 → 校验 CA → 备份并修改两个原生入口 → 写入连接与代理设置 → 重启对应 Cursor
关闭接管 → 禁用网关 → 按哈希还原入口 → 清除托管代理设置 → 停止代理
```

原生网关使用进程级随机凭据，独立于 External API 的开关和密钥。服务商密钥留在 BYOK 配置或账号插件中，不写进 Cursor 模型目录。备份位于用户数据目录；Cursor 更新替换文件后，不会用旧备份覆盖新版本。

## 一次 Agent 调用

```text
Cursor 模型菜单
  ← 本机原生模型菜单工厂生成参数与默认值
  ← BYOK 附加路由 ID、显示名称和来源

用户选择 byok:<配置标识> 并提交
  → 已初始化的 Cursor Agent Host
  → 路由模块解析真实模型 ID 与专属模型地址
  → Cursor LocalAgentClient + 现有原生 Host 适配器
      ├─ 原生模型家族判断 → 提示词与工具定义
      ├─ 原生会话上下文 / MCP / 权限 / checkpoint
      └─ 原生模型与工具循环
           ├─ 模型 HTTP 请求 → BYOK 网关 → provider / 账号插件 → 服务商
           │                      ← 流式响应 ←────────────────────┘
           ├─ 工具调用 → 原生工具执行与交互 → 结果回到原生循环
           └─ 原生状态保存、工具卡片、编辑审阅与最终回答
```

路由继续传递 Host 原有的 `conversationState`、`resources`、`blobStore`、`checkpointHandler`、`conversationActionManager`、`interactionListener` 与 `mcpTools`。读取私有 API 的调用保留在原扩展上下文中，不新增 API 权限。

每个配置使用单独的网关路径，同名模型可属于不同账号或服务地址。真实模型 ID 进入原生工厂，配置哈希不会被误认为模型家族。菜单参数与模型详情由原生 protobuf 实现序列化，BYOK 不维护 Agent 工具 protobuf 或家族映射表。

## 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 模型循环、工具任务、取消与重试 | Cursor 原生运行时 | 当前原生 Run |
| 对话、待办、已读文件、checkpoint、Agent Store | Cursor | 同一会话，按原生机制恢复 |
| 模型路由与网关凭据 | `local_app/` | BYOK 进程及接管状态 |
| 模型、账号、用量与诊断 | BYOK | 本地持久化 |
| 模型目录缓存 | `local_app/native_agent.rs` | 模型配置或运行时变化即失效 |
| 表单草稿与展开状态 | 桌面前端 | 当前编辑过程 |

停止按钮沿原生取消信号关闭模型 HTTP 流，网关同步终止上游连接。模型请求使用原生会话与 generation 标识记录，避免为每个工具往返生成新的会话缓存标识。

关闭接管拒绝后续模型请求，并恢复入口与代理设置；当前任务和进行中的工具交互仍归 Cursor 管理，停止当前运行使用 Cursor 的停止按钮。

普通工具往返不改写历史；摘要由 Cursor 管理。切换模型或重启后，新 Run 使用当前安装的原生工厂。BYOK 不保存另一套 Agent checkpoint，也不承诺替代 Cursor 恢复在途任务。

默认模型由 `store/cursor_model.rs` 持久化在现有设置表中。桌面通过管理 API 保存稳定的模型 ID，`cursor/services/default_model.rs` 将其作为 `GetDefaultModel` 的结果交给 Cursor，并用递增更新时间触发原生默认设置刷新。已配置时，`GetDefaultModelNudgeData` 关闭自动切回 Auto 的服务端提示。此路径不修改 Workbench bundle 或会话内容；Cursor 仍负责显式的会话模型选择。

## 已移除的实现

已删除 `server/src/run/`，以及 `cursor/` 下的 `compile/`、`prompting/`、`tools/`、`checkpoint/`、`conversation/`、`transport/`、`native/`。旧 Node 工具 worker、Agent 提示模板、固定工具快照、协议提取器和整套 Agent protobuf 也已删除。

旧 Agent 会话的数据库读写模块不再参与运行。既有迁移文件保留校验和，应用不会自动销毁用户的历史数据库；统计与诊断的读取继续保留。

## 其他功能与边界

- TAB 默认官方直连，自定义地址仍由 `cursor/services/tab.rs` 转发。
- Commit 生成仍是独立单次模型调用，使用自己的提交信息模板。
- MCP 的连接、定义和执行由 Cursor 提供。
- WebFetch 使用原生实现；WebSearch 需要上游支持 Responses 内置搜索。原生图像工具的标准 `/images/generations` 请求可转发到直接配置的 OpenAI 兼容接口；账号插件未提供该辅助接口时明确返回不支持。
- 本地原生运行时与云端 Agent 产品不保证完全一致；新型号的家族识别范围取决于本机 Cursor 版本，不自行改写官方提示词或伪装模型家族。
- 当前真实客户端基线为 Windows Cursor 3.25.6。macOS/Linux、Remote SSH、云端工作区和在途子任务跨进程恢复需独立验收。

构建、恢复与验证步骤见[原生接入维护](../server/native-agent/README.md)。
