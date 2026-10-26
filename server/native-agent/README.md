# 原生 Agent 接入

应用启用接管时启用 Cursor Agent Host，并保留原生工作区策略；为 `byok:` 模型选择完整的 `LocalAgentClient`。此目录负责入口、模型路由和搜索后端选择；提示词、工具审批、循环与状态由 Cursor 持有。

`patch.mjs` 同时定位原生 Task 模型选择工厂，`route.cjs` 让该工厂使用当前网关路径中的配置 ID 创建子会话。子任务保存 `byok:` 身份，每个 Run 再解析真实模型；原生提示词家族、工具执行、会话状态及父子运行标识保持各自所有权。普通原生模型不经过这项转换。

```text
patch.mjs           # 结构定位与最小入口改动
route.cjs           # 每个 Run 的模型解析、地址与原生参数传递
control-patch.mjs   # 连接原生动作接收器、注入记录和状态通知
control.test.mjs    # 取消传播、步骤边界投递与后续 Run 隔离回归
search.cjs          # 官方搜索优先，失败时调用现有服务商搜索
search-patch.mjs    # 当前 Host 客户端与原生搜索工厂的绑定
workbench.mjs       # 原生新窗口与新对话的默认模型初始化
catalog.mjs         # 原生模型目录的服务商元数据补充
install.mjs         # 安装、备份、恢复及模型目录序列化
native.test.mjs     # 安装边界、路由与状态所有权回归
workbench.test.mjs  # 新对话默认值、目录等待与已有对话隔离回归
workbench.fixture.mjs # 新窗口和对话创建的合成测试夹具
build.mjs           # 生成嵌入 Rust 的安装器与第三方许可
install.bundle.mjs  # 生成产物，不包含 Cursor bundle
```

修改已安装的 `extensions/cursor-agent-host/dist/main.js`、`extensions/cursor-local-agent-runtime/dist/main.js` 和 `out/vs/workbench/workbench.desktop.main.js`。两个扩展入口选择原生客户端、导出已有工厂并绑定搜索回调；Workbench 入口启用 Host，并为新建前台对话读取 BYOK 默认模型。`product.json` 的对应校验和随入口一同备份、更新和恢复。

## 运行中的控制消息

`route.cjs` 在模型查询前建立每个 Run 的取消作用域，连接 Host 动作管理器的停止信号，并启动动作消费。`control-patch.mjs` 复用本机原生 mailbox、`RemoteConversationActionManager`、隐私转换和注入状态消息，把接收器传给 `LocalAgentClient` 的原生执行器。普通原生客户端继续使用其原有接收器。

Stop 取消该 Run 的模型查询、请求和工具上下文；Steer 通过原生注入记录在下一步骤边界消费，保持 Host turn/generation 身份，回传送达状态以避免结束后重复排队。Run 结束时结束注入记录、移除停止监听并取消作用域；Host 继续负责关闭动作流和会话持久化。结构不匹配时安装失败，不维护另一套 Agent 循环或注入算法。

macOS Cursor 3.27.14 的本机验证覆盖原生 UI、已安装 Rust 网关与本地 Responses 夹具：停止关闭上游连接并记录 `cancelled`；故意补发的旧尾段未进入下一轮；原生 Read 完成后的请求在同一 generation 内收到 Steer 一次。该验证临时设置 `cursor.agentHost.updateMode=none` 使用内置 Harness。热更新 Harness 可绕过安装目录中的入口；本补丁不修改已签名的热更新模块，该路径不属于本次通过的验证范围。

## 搜索后端

每个 Host 路由实例使用自己的 `managedAgentToolsClient` 和原生 WebSearch 工厂。`route.cjs` 在每个 BYOK Run 中按真实模型 ID 创建官方搜索回调，通过当前 LocalAgentClient 的提供商配置传入原生工具工厂，不复制认证信息或会话状态。

工具获得原生审批后先调用官方搜索。成功的答案和来源直接交回原生工具循环；官方不可用、调用失败或响应为空时，才调用原有 `/responses` 搜索路径，由现有 Codex、Grok、Gemini 适配处理。下一次调用仍优先官方，不永久切换后端。取消不触发降级；两路失败保留各自原因。原生 private inference 配置存在时不绑定官方搜索，继续遵守其禁止向 Cursor 后端发送内容的边界。

新窗口首个对话和手动新建对话都直接读取 `GetDefaultModel`，不依赖已消费的更新时间。同步 getter 提前创建的空白对话保留原生对象，默认模型加载后通过原生 setter 应用；加载期间用户已修改的选择不覆盖，该新对话的提交等待初始化结束。原生启动加载找到已有对话时不应用默认值，显式模型、历史恢复、子任务和后台 Agent 保留原生行为。目录尚未包含配置模型时等待原生刷新；仍不可用则报错并阻止该新对话误发 Auto 请求。会话创建、模型参数与记录持久化继续由 Cursor 负责。

## 模型参数与提示词

模型菜单以本机 `buildBottlerocketPickerModels` 生成的消息为基础，使用原生 protobuf 类型补齐明确的服务商思考档位、默认值和窗口容量。`catalog.mjs` 只补充目录数据与当前 Workbench 需要的 variant 路由字段，不改变真实模型 ID 或提示词家族。默认容量优先采用服务商声明，缺失时使用 BYOK 的 200k 工作预算。

每个 Run 通过原生 `fetchLocalProviderModels` 刷新元数据缓存。对原生传输层尚不认识的新型号，用户选择的思考档位通过内部请求头传给网关；网关仅在上游声明支持且原生请求未包含该参数时补齐，并移除内部请求头。工具、提示词、计数和执行循环仍归 Cursor 所有。

频繁摘要曾由菜单参数 `200k`、`1m` 引起：原生客户端使用 `parseInt`，分别读成 200 和 1。上下文窗口现由 BYOK 模型设置管理：原生元数据和每轮参数都使用完整整数，旧会话遗留的 context 参数会被当前配置替换。清除覆盖后使用项目默认预算：GPT 1m、Grok 500k，其他模型取服务商声明的容量或 200k。界面、模型目录与网关共用 `model/configuration.rs` 中的规则；其他模型参数仍使用原生工厂，不恢复旧执行路径。

Cursor 3.25.6 的原生工厂将 `grok-4.6` 映射到 Composer Matterhorn / `cursor-0226`，将 GPT 5.4 映射到 Codex 家族。这是本机实现的行为，不能仅凭 Composer 身份描述判定 BYOK 选错模型。该版本尚未识别的新型号使用其原生通用行为。

## 构建与检查

```sh
node server/native-agent/build.mjs
node server/native-agent/build.mjs --check
node --test server/native-agent/*.test.mjs
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

CI 可移植测试不需要安装 Cursor；真实客户端验证使用独立安装副本、独立 BYOK 数据目录和独立 Cursor 用户目录。非默认安装位置通过 `CURSOR_APP_DIR` 指定。

## 安装与恢复

安装器先定位路由、工厂和对话创建入口并准备完整改动，再备份、记录哈希并写入全部文件。入口结构不匹配、目标不是独立文件或备份校验失败时停止。

`native-agent/installations/` 保存按安装位置区分的清单和原始文件。恢复时只处理哈希仍等于本应用补丁的文件，不覆盖 Cursor 更新产生的新文件。`native-agent/connection.json` 包含本地网关凭据，应保留在用户数据目录。

关闭接管首先禁用路由，再恢复文件与代理设置；正常退出也执行恢复。意外退出后的清单用于下一次启动恢复或重新接管。入口改动需要重启对应 Cursor 进程。

## 验证范围

参数修复的隔离测试完成两轮、8 次真实模型请求，没有摘要；所有相邻请求保持完整历史前缀，并发送 `reasoning_effort: high`。

完整桌面应用验证包含真实 Grok 和 GPT 通道、连续对话、原生待办合并，以及 GPT 家族 `ReadFile → ApplyPatch → ReadFile` 的确定性协议夹具。夹具验证原生执行器和数据格式，不代表真实 GPT 模型质量测试。完成状态见[维护记录](../../docs/MAINTENANCE_STATUS.md)。

本机证据位于忽略目录 `target/native-route-probe/`。不要将请求上下文、安装备份、账号信息、测试数据库或密钥提交到仓库。当前基线为 Windows Cursor 3.25.6；私有入口仍需随升级回归，但不再同步维护 Agent 提示词、工具定义或执行逻辑。
