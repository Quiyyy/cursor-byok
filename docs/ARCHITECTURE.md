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
│   ├── prompt/                       # 嵌入的运行时提示与提交信息模板
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
