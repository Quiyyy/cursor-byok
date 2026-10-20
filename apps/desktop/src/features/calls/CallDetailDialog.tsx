import { useEffect, useState } from "react";
import { api, type CallDetail } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { Modal } from "../../shared/ui/Modal";
import { CallDetails } from "./CallDetails";
import styles from "./CallsPage.module.scss";

export function CallDetailDialog({ callId, onClose }: { callId: string | null; onClose: () => void }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!callId) return;
    let active = true;
    void api.call(callId).then((result) => { if (active) setDetail(result); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [callId]);
  const current = detail?.call.call_id === callId ? detail : null;
  return <Modal fullHeight open={callId !== null} title={current?.call.display_name ?? t("调用详情")} onClose={onClose} closeLabel={t("关闭")}
    banner={current?.call.error_message ? <p role="alert" className={styles.detailError}>{t("错误：{error}", { error: current.call.error_message })}</p> : undefined}
    secondaryAction={<Button onClick={() => { if (callId) void appStore.openCallDetails(callId); }}>{t("在独立窗口中打开")}</Button>}>
    {error ? <p role="alert">{error}</p> : current ? <CallDetails detail={current} /> : <p>{t("正在加载调用详情…")}</p>}
  </Modal>;
}
