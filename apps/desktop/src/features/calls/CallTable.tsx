import type { LlmCall } from "../../shared/api";
import { DataTable, type DataTableColumn } from "../../shared/ui/DataTable";
import { Button } from "../../shared/ui/Button";
import { formatCompactInteger } from "../../shared/utils/numberFormat";
import { useI18n } from "../../i18n/store";
import { callStatusLabel } from "./callStatus";
import styles from "./CallTable.module.scss";

const milliseconds = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(2)} s`;

export function CallTable({ calls, onDetails }: { calls: LlmCall[]; onDetails: (call: LlmCall) => void }) {
  const { locale } = useI18n();
  const columns: DataTableColumn<LlmCall>[] = [
    {
      key: "created_at", header: t("时间"),
      render: (call) => <time dateTime={new Date(call.created_at_ms).toISOString()} className={styles.time}>
        <span>{new Date(call.created_at_ms).toLocaleTimeString(locale)}</span>
        <span className={styles.secondary}>{new Date(call.created_at_ms).toLocaleDateString(locale)}</span>
      </time>,
    },
    {
      key: "model", header: t("模型"),
      render: (call) => <div className={styles.model}><span>{call.display_name}</span><span className={styles.secondary}>{call.model_id}</span></div>,
      title: (call) => call.model_id,
    },
    {
      key: "status", header: t("状态"),
      render: (call) => <span className={[styles.status, styles[call.status]].filter(Boolean).join(" ")}>{callStatusLabel(call.status)}</span>,
      title: (call) => call.error_message ?? undefined,
    },
    { key: "ttft", header: t("首 Token"), render: (call) => milliseconds(call.ttft_ms), className: styles.numeric },
    { key: "duration", header: t("耗时"), render: (call) => milliseconds(call.duration_ms), className: styles.numeric },
    { key: "tokens", header: "Token", render: (call) => call.total_tokens === null ? "—" : formatCompactInteger(call.total_tokens), className: styles.numeric },
    { key: "actions", header: t("操作"), sticky: "right", render: (call) => <Button size="small" onClick={() => onDetails(call)}>{t("详情")}</Button> },
  ];
  return <DataTable className={styles.table} rows={calls} columns={columns} rowKey={(call) => call.call_id} minWidth={680} emptyText={t("没有匹配的调用记录")} />;
}
