# Server 规范

适用于 `server/`，继承[顶层规范](../AGENTS.md)。涉及原生接入时继续读取[接入规范](native-agent/AGENTS.md)。

- 管理功能与模型调用的职责明确；各入口的权限和配置范围不得相互泄漏。
- 传输与协议转换保持请求语义，尊重用户显式选择；不能静默丢失信息或改变行为。
- 业务身份与诊断身份分离，传输和重试不能改变所属会话或执行身份。
- 重试不得重复交付已输出的结果或重复执行已完成的业务操作；失败不得伪装为成功。
- 持久化保持业务语义和数据一致性；凭据只在授权边界内使用。
- 验证受影响的真实入口与行为，遵循[测试规范](../.agents/testing/AGENTS.md)。

按任务查阅：[协议与原生语义](../.agents/skills/cursor-prefix-stability/SKILL.md)、[数据库](../.agents/skills/database-schema/SKILL.md)。跨桌面生命周期变更同时读取[宿主规范](../apps/desktop/src-tauri/AGENTS.md)。
