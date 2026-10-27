import { useEffect, useState } from "react";
import { CallTable } from "./CallTable";
import { PageContent } from "../../shell/layout/PageContent";
import { callsStore, useCallsStore } from "./state";
import styles from "./CallsPage.module.scss";
import { PageActions } from "../../shell/PageActions";
import { TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import { CallDetailDialog } from "./CallDetailDialog";

const CALL_REFRESH_INTERVAL_MS = 2_000;

export function CallsPage() {
  const { calls } = useCallsStore();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const filtered = calls.filter((call) => (status === "all" || call.status === status)
    && `${call.display_name} ${call.model_id} ${call.error_message ?? ""} ${call.call_id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  useEffect(() => {
    let disposed = false;
    const refreshCalls = () => {
      if (!disposed && document.visibilityState === "visible") {
        void callsStore.refreshCalls();
      }
    };

    refreshCalls();
    const interval = window.setInterval(refreshCalls, CALL_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshCalls);
    document.addEventListener("visibilitychange", refreshCalls);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshCalls);
      document.removeEventListener("visibilitychange", refreshCalls);
    };
  }, []);

  const content = <div className={styles.page}>
    <span className={styles.scope}>{t("筛选范围：最近加载的 {count} 条记录（最多 200 条）", { count: calls.length })}</span>
    <CallTable key={`${query}:${status}`} calls={filtered} onDetails={(call) => setSelectedCall(call.call_id)} />
  </div>;
  return <>
    <PageActions position="filters"><div className={styles.filters}>
      <TextInput value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("搜索模型、错误或调用 ID")} placeholder={t("搜索模型、错误或调用 ID")} />
      <Select value={status} onChange={setStatus} ariaLabel={t("调用状态")} options={[
        { value: "all", label: t("全部状态") }, { value: "failed", label: t("失败") },
        { value: "completed", label: t("成功") }, { value: "running", label: t("进行中") }, { value: "cancelled", label: t("已取消") },
      ]} />
    </div></PageActions>
    <PageContent fixed title={t("调用记录")} contentClassName={styles.pageContent} sections={[{ key: "calls", estimatedHeight: 720, content }]} />
    <CallDetailDialog callId={selectedCall} onClose={() => setSelectedCall(null)} />
  </>;
}
