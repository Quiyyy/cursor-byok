# 原生 Agent 接入

应用启用接管时，在已初始化的 Cursor Agent Host 中为 `byok:` 模型选择完整的 `LocalAgentClient`。此目录负责入口和模型路由；提示词、工具、循环与状态由 Cursor 持有。

```text
patch.mjs           # 结构定位与最小入口改动
route.cjs           # 每个 Run 的模型解析、地址与原生参数传递
install.mjs         # 安装、备份、恢复及模型目录序列化
native.test.mjs     # 安装边界、路由与状态所有权回归
build.mjs           # 生成嵌入 Rust 的安装器与第三方许可
install.bundle.mjs  # 生成产物，不包含 Cursor bundle
```

仅修改已安装的 `extensions/cursor-agent-host/dist/main.js` 和 `extensions/cursor-local-agent-runtime/dist/main.js`。前者选择原生客户端，后者导出已有客户端、模型目录和类型工厂。

## 模型参数与提示词

模型菜单直接使用本机 `buildBottlerocketPickerModels`。支持的思考档位、默认值和家族由该工厂决定；上下文上限来自配置的数值元数据或原生客户端的模型信息。不再维护家族提示词文件。

频繁摘要曾由菜单参数 `200k`、`1m` 引起：原生客户端使用 `parseInt`，分别读成 200 和 1。上下文窗口现由 BYOK 模型设置管理：原生元数据和每轮参数都使用完整整数，旧会话遗留的 context 参数会被当前配置替换。清除覆盖后由原生客户端推断默认容量；其他模型参数仍使用原生工厂，不恢复旧执行路径。

Cursor 3.25.6 的原生工厂将 `grok-4.6` 映射到 Composer Matterhorn / `cursor-0226`，将 GPT 5.4 映射到 Codex 家族。这是本机实现的行为，不能仅凭 Composer 身份描述判定 BYOK 选错模型。该版本尚未识别的新型号使用其原生通用行为。

## 构建与检查

```sh
node server/native-agent/build.mjs
node server/native-agent/build.mjs --check
node --test server/native-agent/native.test.mjs
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

CI 可移植测试不需要安装 Cursor；真实客户端验证使用独立安装副本、独立 BYOK 数据目录和独立 Cursor 用户目录。非默认安装位置通过 `CURSOR_APP_DIR` 指定。

## 安装与恢复

安装器先定位两个入口并准备完整改动，再备份、记录哈希并写入文件。入口结构不匹配、目标不是独立文件或备份校验失败时停止。

`native-agent/installations/` 保存按安装位置区分的清单和原始文件。恢复时只处理哈希仍等于本应用补丁的文件，不覆盖 Cursor 更新产生的新文件。`native-agent/connection.json` 包含本地网关凭据，应保留在用户数据目录。

关闭接管首先禁用路由，再恢复文件与代理设置；正常退出也执行恢复。意外退出后的清单用于下一次启动恢复或重新接管。入口改动需要重启对应 Cursor 进程。

## 验证范围

参数修复的隔离测试完成两轮、8 次真实模型请求，没有摘要；所有相邻请求保持完整历史前缀，并发送 `reasoning_effort: high`。

完整桌面应用验证包含真实 Grok 和 GPT 通道、连续对话、原生待办合并，以及 GPT 家族 `ReadFile → ApplyPatch → ReadFile` 的确定性协议夹具。夹具验证原生执行器和数据格式，不代表真实 GPT 模型质量测试。完成状态见[维护记录](../../docs/MAINTENANCE_STATUS.md)。

本机证据位于忽略目录 `target/native-route-probe/`。不要将请求上下文、安装备份、账号信息、测试数据库或密钥提交到仓库。当前基线为 Windows Cursor 3.25.6；私有入口仍需随升级回归，但不再同步维护 Agent 提示词、工具定义或执行逻辑。
