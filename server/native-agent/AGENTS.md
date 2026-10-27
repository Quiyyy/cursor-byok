# Cursor 原生接入维护规范

适用于 `server/native-agent/`，继承 [Server 规范](../AGENTS.md)。修改或审查本目录前读取 [cursor-prefix-stability](../../.agents/skills/cursor-prefix-stability/SKILL.md)；安装与本机步骤见 [README.md](README.md)。

## 边界

```text
安装器 → 已安装 Cursor 的结构定位 / 备份 / 修改 / 还原
原生 Host → route → 原生 LocalAgentClient → BYOK 模型 HTTP
原生动作管理器 → Stop / Steer → 当前 Run 的原生执行器
原生工具与会话状态 → Cursor 自己管理并持久化
```

- 本目录只接入现有原生机制。模型菜单和提示词家族由本机 Cursor 工厂提供，不添加伪装模型、固定家族表或第二套工具执行器。
- Host 状态与适配器保持原有引用和所有权。普通工具往返不能改写已有请求前缀；新 generation、恢复会话和子任务不能因路由而串用身份。
- Stop、Steer、模型查询、原生工具上下文与 HTTP 请求有不同边界。测试某个辅助函数收到取消，不能等同于原生 UI 的停止链路通过。
- 安装器只处理能够识别的结构；结构不匹配应明确失败，不引入猜测性补丁或旧实现回退。Cursor 升级后的恢复不能用旧备份覆盖新文件。
- 默认模型初始化只作用于符合条件的新对话，保留历史会话、用户显式选择和子任务的原生行为。

## 修改与验收

- 源文件是维护入口；`install.bundle.mjs` 是生成产物。改动相关源码后通过 `build.mjs` 生成，并检查 bundle 一致性，不手改生成 bundle。
- 原生路由、安装和控制边界使用先失败后通过的回归测试。沿真实 Host 到请求 / 工具的链路选择断言，不以合成对象替代所有运行时条件。
- 涉及真实接入的改动，验证隔离 Cursor 安装与 profile、隔离 BYOK 数据和实际桌面构建；保留安装前后与恢复后的文件校验依据。
- 记录 Cursor 版本、平台、使用的内置或热更新 Harness、触及的工具和协议。未覆盖的 Harness、Remote SSH、云端或跨进程恢复明确留为未验证。
- 本地模拟 Provider 可以验证传输、历史前缀和取消传播，但不能证明真实服务商能力、额度或服务端停止计算。
- 避免在用户日常安装上试错；不要提交 Cursor 私有 bundle、真实账号数据或临时安装产物。按[测试规范](../../.agents/testing/AGENTS.md)清理自己创建的进程与副本。
