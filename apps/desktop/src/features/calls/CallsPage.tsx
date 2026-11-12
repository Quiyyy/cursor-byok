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
  const { calls, loaded, error } = useCallsStore();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const filtered = calls.filter((call) => (status === "all" || call.status === status)
    && (source === "all" || call.source === source)
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

  const emptyText = !loaded && !error
    ? t("正在加载调用记录…")
    : calls.length === 0 && error
      ? error
      : calls.length === 0
        ? t("暂无调用记录")
        : t("没有匹配的调用记录");

  const content = <div className={styles.page}>
    <span className={styles.scope}>{t("筛选范围：最近加载的 {count} 条记录（最多 200 条）", { count: calls.length })}</span>
    <CallTable key={`${query}:${status}:${source}`} calls={filtered} emptyText={emptyText} onDetails={(call) => setSelectedCall(call.call_id)} />
  </div>;
  return <>
    <PageActions position="filters"><div className={styles.filters}>
      <TextInput value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("搜索模型、错误或调用 ID")} placeholder={t("搜索模型、错误或调用 ID")} />
      <Select value={source} onChange={setSource} ariaLabel={t("调用来源")} options={[
        { value: "all", label: t("全部来源") },
        { value: "native_agent", label: "Cursor Agent" },
        { value: "commit", label: "Commit" },
        { value: "external_api", label: "External API" },
        { value: "model_test", label: t("模型测试") },
      ]} />
      <Select value={status} onChange={setStatus} ariaLabel={t("调用状态")} options={[
        { value: "all", label: t("全部状态") }, { value: "failed", label: t("失败") },
        { value: "completed", label: t("成功") }, { value: "running", label: t("进行中") }, { value: "cancelled", label: t("已取消") },
      ]} />
    </div></PageActions>
    <PageContent fixed title={t("调用记录")} contentClassName={styles.pageContent} sections={[{ key: "calls", estimatedHeight: 720, content }]} />
    <CallDetailDialog callId={selectedCall} onClose={() => setSelectedCall(null)} />
  </>;
}
