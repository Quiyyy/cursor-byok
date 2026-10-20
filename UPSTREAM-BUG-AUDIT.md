# 上游问题排查与修复

检查日期：2026-10-20。上游 [leookun/cursor-byok](https://github.com/leookun/cursor-byok) 已归档，本记录以其最后 `main` 提交 `31e9f5cbc98a7d28cffcb5efbb9323cd3e143354` 为基线，检查当日 105 个未关闭 Issue 和 54 个未合并 PR。

优先处理会导致请求失败、工具结果丢失、会话不能继续或错误执行工具的问题。Issue 未关闭不等于当前版本仍有问题；没有最小复现的报告不作为“已修复”依据。此表只声明源码和自动回归覆盖的行为，安装包发布与真实 Cursor 验收单独进行。

## 本分支修复

| 来源 | 问题与修复 | 回归依据 |
| --- | --- | --- |
| [#477](https://github.com/leookun/cursor-byok/issues/477)、[#484](https://github.com/leookun/cursor-byok/pull/484) | 子代理请求可能只带一个父级标识或没有 `message_id`。父级请求与工具标识独立可选；启动、追加消息和上下文注入统一使用稳定的消息内容摘要补齐缺失 ID。 | 父级标识四种组合、缺失 ID、父请求已结束、相同文本不同上下文的身份测试。 |
| [#424](https://github.com/leookun/cursor-byok/pull/424)、[#487](https://github.com/leookun/cursor-byok/pull/487) | Steer 保留 Task 后错误屏蔽其事件，且父 Run 结束会丢失迟到结果。结果由原 transport 持有，前台等待记录“仍在运行”，完成结果只追加一次，必要时继续父会话。显式取消和替换仍取消原任务。 | `interrupt` 与 Task 单测覆盖完成早于/晚于 Steer、父 Run 已结束、重复结果、混合工具、取消、复用 call ID、检查点和最终 `turnEnded`。不包含进程重启后的在途任务恢复。 |
| [#509](https://github.com/leookun/cursor-byok/issues/509)、[#420](https://github.com/leookun/cursor-byok/pull/420) | MCP 的 `minLength: 1.0` 等整数约束遭严格接口拒绝。递归处理 Schema 关键字，保留已有整数精度，不改 `default`、`examples` 等实例数据。 | 嵌套 Schema、组合关键字、非整数、大整数和字面值测试。 |
| [#410](https://github.com/leookun/cursor-byok/issues/410)、[#501](https://github.com/leookun/cursor-byok/pull/501) | Responses 不同输出项共用文本基线，导致最终文字丢失或终态快照重复。按 `output_index` 保存增量基线。 | `responses_text` 覆盖多输出项、delta、done、终态快照与空输出。 |
| [#505](https://github.com/leookun/cursor-byok/issues/505) | 多个 reasoning signature 被当成错误。合并同一协议的签名块，保留原顺序；Cursor 不透明签名保留其原始 reasoning 片段与文本。 | 多签名检查点往返、多个模型回放事件。未知签名不会被伪造或转换成另一服务商的签名。 |
| [#423](https://github.com/leookun/cursor-byok/pull/423)、[#500](https://github.com/leookun/cursor-byok/pull/500) | Anthropic 返回 `refusal` 后仍可能运行此前缓冲的工具。拒绝以独立且不可重试的失败结束，工具不会进入执行。 | `anthropic_refusal` 覆盖拒绝加工具、普通结束加工具、长度截断、不完整 SSE 和 Cursor exec 输出。 |
| [#481](https://github.com/leookun/cursor-byok/issues/481)、已有 [#445](https://github.com/leookun/cursor-byok/issues/445) / [#459](https://github.com/leookun/cursor-byok/pull/459) | ChatGPT 缺少自动续期；Google 在模型请求内部刷新、请求完成后才保存，容易丢失轮换令牌。三类插件统一在宿主账号锁下准备并先保存凭据；首次且尚未输出的 401 才允许续期重试一次。 | 三类插件、共享 SDK 和宿主并发/取消/磁盘写入失败测试。临时错误退避；已撤销授权仍需重新登录。 |
| [#508](https://github.com/leookun/cursor-byok/issues/508)、[#474](https://github.com/leookun/cursor-byok/pull/474) | HTTP Client 永久缓存旧代理。每两秒检查生效代理配置，变化时重建缓存；覆盖 Windows 注册表、macOS HTTP(S) 系统设置、代理环境变量和自定义设置。 | 本地两个模拟代理验证运行中切换；读配置失败时保留缓存。未变更的代理地址所对应进程已停止时，仍会按系统设置报连接错误。 |
| [#513](https://github.com/leookun/cursor-byok/pull/513) | 失败写入留下事务，连接复用导致后续请求持续锁库。连接归还时先处理排队的回滚，仍在事务中的连接直接关闭。 | 延迟外键导致提交失败、未结束事务归还连接后，后续多次写入正常。未引入 PR 中跨 17 个文件的事务封装改写。 |
| [#511](https://github.com/leookun/cursor-byok/issues/511) | 删除统计记录不归还 SQLite 文件空间。现有手动清理操作提交后执行 `VACUUM` 与 WAL 截断。 | 4 MiB 明细清理后文件缩小，统计与会话按清理范围保留。此项改善手动空间回收，不新增自动保留周期，也不删除用户会话。 |

## 广告移除

删除前端广告弹窗、广告菜单、加载与关闭请求、缓存读写、专属样式与翻译；删除后端广告控制接口和仅用于广告的 installation ID。无启动时的广告拉取或设备标识请求。正常更新提示与操作教程仍可使用。

历史广告缓存属于用户目录，源码更新后不再读取；本次不扫描或删除用户旧文件。

## 仍需复现或单独验收

- [#469](https://github.com/leookun/cursor-byok/issues/469) / [#498](https://github.com/leookun/cursor-byok/pull/498)：Remote SSH 涉及远端推理路由、搜索与 WebFetch，需真实远端工作区验证。本批不将其 30 多文件改动直接混入稳定性修复。
- [#493](https://github.com/leookun/cursor-byok/pull/493)：语音输入和 Agent 诊断的 HTTP/2 双向流；该 PR 同时改动代理层，测试清单未完成。本批未引入第三方代理库副本。
- [#504](https://github.com/leookun/cursor-byok/issues/504)：历史消息重复报告尚缺脱敏协议样本和稳定复现；不能据当前消息 ID 修复宣称该问题全部解决。
- [#458](https://github.com/leookun/cursor-byok/pull/458)：Windows 终端参数与证书存储范围；需单独验证安装/卸载和已有机器级证书，未混入本批。
- [#460](https://github.com/leookun/cursor-byok/pull/460)：缺失 usage 时估算上下文。固定 200k 容量不适合所有自定义模型，需明确估算与真实用量的产品语义后处理。
- [#318](https://github.com/leookun/cursor-byok/issues/318)：当前 Responses 图像请求已经包含 `detail: "auto"`，不是本轮新增修复。
- [#229](https://github.com/leookun/cursor-byok/pull/229)、[#375](https://github.com/leookun/cursor-byok/pull/375)、[#378](https://github.com/leookun/cursor-byok/pull/378)：目标包含已被替换的旧目录/执行结构，不能直接套用旧补丁；当前会话恢复与压缩继续由现有回归测试验证。

## 测试隔离与来源

排查中发现原 External API 集成测试使用真实用户插件目录，导致本地测试结果受已配置模型影响，并可能重装内置插件。现改用显式临时目录；新增的 Anthropic 测试同样隔离。测试数据仅含虚构凭据。

采纳或改写的上游方案来自 `lawyer112`（#420）、`kevin9327`（#424）、`GGboya`（#474 的代理缓存部分）、`okfanger`（#484）、`haohaomin`（#487、#500、#501）、`banchen21`（#513 的问题分析）。保留原项目 MIT 许可。#474 中无关的知识库改动和诊断输出没有带入。
