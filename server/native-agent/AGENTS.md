# Cursor 原生接入规范

适用于 `server/native-agent/`，继承 [Server 规范](../AGENTS.md)。

- 接入不得改变原生会话、用户选择和请求历史的语义。
- 明确支持范围；无法可靠接入时明确失败，不伪装能力或静默改走另一种行为。
- 安装与恢复的修改范围明确、可核验，不损坏用户数据或无关版本内容。
- 接入验证使用隔离环境；结论限定到实际覆盖的产品行为和运行环境，遵循[测试规范](../../.agents/testing/AGENTS.md)。

专项规则见[协议与原生语义技能](../../.agents/skills/cursor-prefix-stability/SKILL.md)，当前实现与操作见 [README.md](README.md)。
