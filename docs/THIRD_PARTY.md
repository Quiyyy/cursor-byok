# 第三方与来源说明

项目由当前维护团队持续开发；现有代码的来源、提交作者和许可证不会因维护方变化而改写。根目录 [LICENSE](../LICENSE) 保留已有版权及许可文本，代码贡献历史可通过 Git 查询。

## Semble

`crates/semble-core/` 是 Rust 实现的本地代码索引与混合搜索核心。现有实现与兼容性样本的来源记录：

- 项目：<https://github.com/MinishLab/semble>
- 基线提交：`921849164e2632dd4f0e1c1370f82cfe15ed6d6c`
- 原来源记录标注许可：MIT
- 使用的模型标识：`minishlab/potion-code-16M-v2`

该研究库目前不参与桌面应用的 Agent 执行。Rust 实现在运行时不依赖 Python。模型权重有独立的来源与使用条款，不能用仓库的代码许可证代替。

基准数据与方法见 [Semble 基准说明](../support/benchmarks/semble/README.md)。既有报告是对应提交和机器上的历史测量，不能视为当前版本重新跑分的结果。

## 图形与字体

- Cursor、模型服务商及账号插件的品牌图形用于标识对应产品，不表示官方合作或认可。
- 项目应用图标源文件位于 `apps/desktop/src-tauri/icons/icon.svg`。
- UI 图标通过已声明的 Iconify 数据和组件使用；具体图标集按各自许可处理。
- 当前字体文件为 `PingFang-Medium.ttf` 和 `HFKos-R.ttf`。仓库未附这两个文件的独立授权文本；维护时应核实来源与分发权限，不应将其宣称为维护团队原创或统一按 MIT 授权。

## 依赖

Rust、JavaScript 和 Go 依赖分别以相应清单和锁文件为准。更新、再分发或替换依赖时保留该依赖要求的许可与版权文本。

## Cursor 原生运行时与入口安装器

`server/native-agent/install.bundle.mjs` 仅包含本项目安装与路由代码及 Babel 等构建依赖，不包含 Cursor 原生 bundle、提示词或工具实现。构建保留依赖 legal comments，并生成 `server/native-agent/THIRD_PARTY_LICENSES.txt`，安装器与许可说明一起写入本地用户数据目录。

运行时从用户已安装的 Cursor 调用原生工厂，并为可恢复的安装改动在本机保存原始文件备份。Cursor 代码与服务受其自身条款约束，不属于本仓库 MIT 授权范围。原生备份、请求记录和本机账号数据不得提交到仓库。
