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
│   ├── workbench.mjs            # 在原生新窗口、新对话创建入口初始化默认模型
│   ├── install.mjs              # 安装、备份、还原与原生模型目录生成
│   ├── native.test.mjs          # 路由、所有权与安装恢复回归
│   ├── workbench.test.mjs       # 默认模型初始化及已有对话隔离回归
│   ├── workbench.fixture.mjs    # 新窗口和对话创建的可移植测试夹具
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

开启接管 → 校验 CA → 备份并修改原生路由及新对话入口 → 写入连接与代理设置 → 重启对应 Cursor
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

原生 Task 的模型选择入口从当前网关路径保留 `byok:` 配置身份，然后由 Cursor 创建并持久化子会话。子 Run 再通过同一路由解析真实模型，父子会话和 generation 标识保持独立；真实模型 ID 继续决定提示词家族。配置身份在子会话创建之前传入，避免子任务误走官方模型通道，或恢复子会话时丢失配置。

```text
父 Run：真实模型用于提示词与模型请求
  → 原生 Task 选择 byok:<配置标识>
  → 原生 Host 创建并持久化子会话
  → 子 Run：独立会话和 generation 标识
      → BYOK 路由解析真实模型 → 网关 → 服务商
      ← 原生模型/工具循环 ← 响应
  ← 原生 Task 回传子任务结果
```

## 原生接入与搜索协议边界

执行循环、工具定义、工具执行、会话与 checkpoint 由安装的 Cursor 提供。BYOK 负责配置身份、服务地址、凭据与协议传输。这种接入依赖对 Cursor 私有运行时的结构定位补丁，并非官方公开扩展 API；入口不匹配时安装失败，升级后的行为仍需回归。

```text
server/
├── native-agent/                         # 原生模型路由接入
│   ├── patch.mjs                        # 定位 Host 与 Task 模型工厂
│   ├── route.cjs                        # 配置 ID 与真实模型 ID 的映射
│   └── install.mjs                      # 安装、哈希校验与恢复
├── src/                                 # 本地服务与插件宿主
│   ├── api/byok/                        # 模型 HTTP 网关
│   │   ├── protocol.rs                  # 选择原始 Responses 或普通协议投影
│   │   ├── output.rs                    # 输出协议响应及原始 response.* 事件
│   │   └── search.rs                    # 校验原生搜索结果并补齐来源链接
│   └── plugin/                          # 账号插件执行与分发
│       ├── sdk/                         # 插件请求、事件与协议契约
│       └── builtin.rs                   # 内置插件文件嵌入及按版本更新
└── plugins/build-in/                    # 服务商适配
    ├── codex-auth/provider.ts           # Codex Responses 请求
    ├── grok-auth/provider.ts            # xAI 对话和 Responses 请求
    └── antigravity-auth/                # Google Cloud Code 接入
        ├── provider.ts                  # 请求、流读取及错误分类
        └── search.ts                    # Google grounding 与 Responses 搜索结果转换
```

本次结构变化是新增网关的 `search.rs`、Google 插件的 `search.ts` 和对应测试，其余在现有模块内扩展。

```text
Cursor 原生 WebSearch
  → 原生辅助 /responses 请求
  → BYOK 网关：能力检查；缺省要求执行搜索
      ├─ 直接 Responses 配置 → 所选服务商
      ├─ Codex 账号 → Codex Responses 后端
      ├─ Grok 账号 → xAI /v1/responses → web_search
      └─ Gemini 账号 → Google Cloud Code → googleSearch
           ← groundingMetadata + 答案 + 用量
           → 对应的 Responses 搜索项、答案与引用
  ← 搜索完成校验；来源链接补入 output_text
  → Cursor 原生工具结果 → 主 Agent 循环
```

- Responses 内置工具请求保留原始请求体、签名输入及 `response.*` 事件，不经过普通函数工具的消息投影。账号插件显式声明 `nativeResponses` 后才进入这条路径。
- Grok 将 Cursor 的 `web_search_preview` 名称映射为 xAI 的 `web_search`。普通对话继续使用原有 Chat Completions 通道。
- Gemini 分支限于原生单次文本 WebSearch：将查询交给 `googleSearch`，汇集可能分段返回的 grounding 元数据。只有存在上游搜索证据且正常完成，才产生已完成的搜索项；原始 grounding 元数据、来源与用量均保留。任意 Responses 会话回放、其他内置工具和无法映射的搜索选项会明确报错。
- 对原生非流式辅助搜索，网关在未显式选择工具时补入 `tool_choice: required`，要求响应包含已完成的 `web_search_call` 和非空答案。普通“准备搜索”的文本不算成功。来源仅出现在 annotations 时补入 `output_text`，原始输出项不变。
- Google 的 401/403/429 不再继续尝试其他端点，避免被后续 404 覆盖。取消和中途失败不会被转换成搜索完成。
- `nativeResponses` 是协议接入能力，不代表所有账号和模型都有搜索权限；模型能力、可用性与额度由上游决定。普通 Chat Completions 通道不自动获得搜索能力。

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

默认模型由 `store/cursor_model.rs` 持久化在现有设置表中，`cursor/services/default_model.rs` 通过原生 `GetDefaultModel` 接口提供稳定的 BYOK 路由 ID。递增更新时间仍供原生设置刷新使用，但不作为新窗口初始化的条件。创建入口通过内部请求头只查询本地覆盖值；未配置时立即保留原生选择，不额外等待官方默认模型接口。

`native-agent/workbench.mjs` 定位原生启动数据加载和新对话创建入口：需要创建新对话时读取配置，必要时等待原生模型目录刷新，再把模型配置交给原生工厂和持久化过程。同步 getter 提前创建的首个空白对话在初始化完成前暂缓提交；模型通过原生 setter 更新，等待期间用户已修改的选择保留。等待状态只属于该新对话，已有对话不受影响。启动加载找到已有对话时不读取或覆盖其模型；显式指定模型、恢复历史、子任务和后台 Agent 保留原生路径。已配置的模型不可用时报告错误，不用 Auto 发送请求。已配置默认模型时，`GetDefaultModelNudgeData` 和独立的 `GetNewChatNudgeParameterizedModelPicker` 都不返回自动切换推荐，避免初始化后再次被覆盖。

```text
新窗口 → 原生读取已有对话
          ├─ 找到已有对话 → 按其模型与参数恢复
          └─ 需要新对话 → GetDefaultModel → 等待模型目录 → 原生创建并保存
新建对话 → 显式模型或恢复状态？
          ├─ 是 → 原生选择
          └─ 否 → GetDefaultModel → 等待模型目录 → 原生创建并保存
```

安装器将 Workbench 入口与两个扩展入口一并备份、写入和恢复，并同步 `product.json` 中的 Workbench 文件校验和；不分发 Cursor 源码，也不改写已存储的对话记录。

上下文窗口由 BYOK 的模型设置统一管理。`store/model_settings.rs` 复用 API 模型的现有字段，并在现有设置表中独立保存账号模型覆盖值；同一个管理 API 服务两种模型。模型目录和原生网关读取同一配置，`native-agent/route.cjs` 在每个 Run 开始时将整数 Token 数传给原生参数，并移除旧会话遗留的 context 参数。进行中的 Run 不被重置，下一轮沿用原会话状态并应用新容量。

目录补充由 `native-agent/catalog.mjs` 完成：上游声明的思考档位、默认档位和上下文容量进入原生消息，variant 的路由字段保持 BYOK 模型身份，避免被 Workbench 误当作 Auto。原生客户端每轮刷新自己的模型元数据缓存；当新型号的原生传输层省略已选思考档位时，网关只补齐上游明确支持且请求中缺失的值。上下文占用量仍来自原生会话 Token 状态，不在 BYOK 重建估算器。

## 已移除的实现

已删除 `server/src/run/`，以及 `cursor/` 下的 `compile/`、`prompting/`、`tools/`、`checkpoint/`、`conversation/`、`transport/`、`native/`。旧 Node 工具 worker、Agent 提示模板、固定工具快照、协议提取器和整套 Agent protobuf 也已删除。

旧 Agent 会话的数据库读写模块不再参与运行。既有迁移文件保留校验和，应用不会自动销毁用户的历史数据库；统计与诊断的读取继续保留。

## 其他功能与边界

- TAB 默认官方直连，自定义地址仍由 `cursor/services/tab.rs` 转发。
- Commit 生成仍是独立单次模型调用，使用自己的提交信息模板。
- MCP 的连接、定义和执行由 Cursor 提供。
- WebFetch 使用原生实现；WebSearch 的接入边界见上文。
- 原生图像工具的标准 `/images/generations` 请求可转发到直接配置的 OpenAI 兼容接口；账号插件未提供该辅助接口时明确返回不支持。
- 本地原生运行时与云端 Agent 产品不保证完全一致；新型号的家族识别范围取决于本机 Cursor 版本，不自行改写官方提示词或伪装模型家族。
- 当前真实客户端基线为 Windows Cursor 3.25.6。macOS/Linux、Remote SSH、云端工作区和在途子任务跨进程恢复需独立验收。

构建、恢复与验证步骤见[原生接入维护](../server/native-agent/README.md)。

## 模型目录的已知问题（待修）

当前 `plugins/build-in/antigravity-auth/models.ts` 在成功读取上游目录后，仍会合并 `STATIC_ANTIGRAVITY_MODELS`。这会把该账号上游未提供的旧型号重新列入可选项。诊断中 `gemini-3.7-flash-medium` 不在上游目录，普通请求与搜索请求均返回 429；使用目录内的 `gemini-3.8-flash-medium` 后真实搜索成功。因此，该次 429 不能直接归因为账号额度耗尽。

这段静态补型号逻辑尚未修改。下一步应让成功同步的账号模型目录以上游实际返回为准，并针对下架型号与既有选择补充回归；这是待实施的目录修复，不属于已完成的搜索协议适配。验证范围与证据见[维护状态](./MAINTENANCE_STATUS.md)。
