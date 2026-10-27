# 桌面与前端规范

适用于 `apps/desktop/`，继承[顶层规范](../../AGENTS.md)。涉及桌面宿主时继续读取[宿主规范](src-tauri/AGENTS.md)。

- 界面负责展示与交互；服务端业务状态以服务端为准，前端不另建一套权威业务规则。
- 业务状态与临时交互状态职责明确，共享能力不依赖无关页面的存在。
- 用户操作的进度、结果与错误应准确表达；失败后的恢复操作应可达。
- 复用一致的交互、视觉与本地化规则，保持键盘可用性和必要的可访问性。
- 交互变更须通过用户可用的操作验证，不能仅检查内部状态；遵循[测试规范](../../.agents/testing/AGENTS.md)。

按任务查阅：[前端](../../.agents/skills/frontend/SKILL.md)、[浮层](../../.agents/skills/floating-ui/SKILL.md)、[模型选择](../../.agents/skills/model-selection/SKILL.md)、[本地化](../../.agents/skills/i18n/SKILL.md)。具体实现与操作说明不在本规范重复。
