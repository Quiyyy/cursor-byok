import type { CallDetail } from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { Button } from "../../shared/ui/Button";
import { JsonEditor } from "../../shared/ui/JsonEditor";
import { Tabs, type TabItem } from "../../shared/ui/Tabs";
import styles from "./CallDetails.module.scss";
import { callStatusLabel } from "./callStatus";

const show = (value: string | number | null) => value ?? "-";
const timing = (value: number | null) => value == null ? "-" : `${value} ms`;

export function CallDetails({ detail, onOpenSettings }: { detail: CallDetail; onOpenSettings?: () => void }) {
  const { locale } = useI18n();
  const { call, request, response_chunks: chunks } = detail;
  const responseBody = chunks.map((chunk) => chunk.data).join("");
  const responseBytes = chunks.reduce((total, chunk) => total + chunk.byte_count, 0);
  const fieldGroups: Array<{ title: string; fields: Array<[string, string | number]> }> = [
    {
      title: t("概览与状态"),
      fields: [
        [t("状态"), callStatusLabel(call.status)],
        [t("调用来源"), ({ native_agent: "Cursor Agent", external_api: "External API", commit: "Commit", model_test: t("模型测试") })[call.source]],
        [t("调用时间"), new Date(call.created_at_ms).toLocaleString(locale)],
        [t("HTTP 状态码"), show(call.http_status)],
        [t("结束原因"), show(call.finish_reason)],
        [t("详细记录"), call.detailed ? t("是") : t("否")],
        ...(call.error_kind || call.error_message ? [
          [t("错误类型"), show(call.error_kind)] as [string, string | number],
          [t("错误信息"), show(call.error_message)] as [string, string | number],
        ] : []),
      ],
    },
    {
      title: t("耗时与用量"),
      fields: [
        [t("耗时"), timing(call.duration_ms)],
        [t("首 Token (TTFT)"), timing(call.ttft_ms)],
        ["TTFB", timing(call.ttfb_ms)],
        ["TTFR", timing(call.ttfr_ms)],
        [t("总 Token"), show(call.total_tokens)],
        [t("输入 Token"), show(call.input_tokens)],
        [t("输出 Token"), show(call.output_tokens)],
        [t("缓存读取 Token"), show(call.cache_read_tokens)],
        [t("缓存写入 Token"), show(call.cache_write_tokens)],
        [t("思考 Token"), show(call.reasoning_tokens)],
        [t("消息数"), call.message_count],
        [t("工具数"), call.tool_count],
      ],
    },
    {
      title: t("模型与路由"),
      fields: [
        [t("显示名称"), call.display_name],
        ["Model ID", call.model_id],
        [t("思考强度"), show(call.reasoning_effort)],
        ["Fast", call.fast == null ? "-" : call.fast ? t("是") : t("否")],
        [t("上游类型"), call.provider_type],
        [t("最终请求类型"), call.request_type],
        [t("上游地址"), call.provider_url],
        [t("最终请求地址"), call.request_url],
      ],
    },
    {
      title: t("会话与标识"),
      fields: [
        ["Call ID", call.call_id],
        ["Run ID", call.run_id],
        ["Conversation ID", call.conversation_id],
        ["Model Hash", show(call.model_hash)],
      ],
    },
  ];

  const tabs: TabItem[] = [
    { value: "call", label: t("调用信息"), content: <section className={styles.groups}>
      {fieldGroups.map((group) => <div key={group.title} className={styles.group}>
        <h4>{group.title}</h4>
        <dl className={styles.details}>{group.fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}</dl>
      </div>)}
    </section> },
    { value: "request", label: t("请求"), content: <section>
      {request ? <>
        <div className={styles.meta}>{t("字节数")}：{request.byte_count}</div>
        <h4>{t("请求头")}</h4><JsonEditor ariaLabel={t("请求头")} value={JSON.stringify(request.headers)} readOnly />
        <h4>{t("请求体")}</h4><JsonEditor ariaLabel={t("请求体")} value={JSON.stringify(request.body)} readOnly detail />
      </> : <div className={styles.emptyState}>
        <span className={styles.empty}>{t("未记录请求内容，可在系统设置的「调用观测」中开启详细模式。")}</span>
        {onOpenSettings && <Button size="small" onClick={onOpenSettings}>{t("前往系统设置")}</Button>}
      </div>}
    </section> },
    { value: "response", label: t("响应流"), content: <section>
      {chunks.length > 0 ? <>
        <div className={styles.meta}>{t("分块数")}：{chunks.length} · {t("字节数")}：{responseBytes}</div>
        <JsonEditor ariaLabel={t("响应流")} value={responseBody} readOnly detail />
      </> : <div className={styles.emptyState}>
        <span className={styles.empty}>{t("未记录响应内容，可在系统设置的「调用观测」中开启详细模式。")}</span>
        {onOpenSettings && <Button size="small" onClick={onOpenSettings}>{t("前往系统设置")}</Button>}
      </div>}
    </section> },
  ];

  return <div className={styles.root}><Tabs items={tabs} /></div>;
}
