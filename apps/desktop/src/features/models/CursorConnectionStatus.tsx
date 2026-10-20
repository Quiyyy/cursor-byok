import type { CursorHarnessStatus } from "../../shared/api";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { connectionIcon } from "../../shared/ui/workbenchIcons";
import styles from "./ModelWorkbench.module.scss";

export function CursorConnectionStatus({ status, busy, modelCount, visibleCount, onToggle, onAccounts }: {
  status: CursorHarnessStatus | null;
  busy: boolean;
  modelCount: number;
  visibleCount: number;
  onToggle: (enabled: boolean) => void;
  onAccounts: () => void;
}) {
  const enabled = status?.integration === "enabled" && status.settings_applied && status.ca === "ready";
  const taken = status?.settings_applied || status?.integration === "enabled";
  const title = !status ? t("正在检查 Cursor 接入")
    : enabled ? t("Cursor 接入正常")
    : status.ca !== "ready" ? t("Cursor 接入需要初始化证书")
    : status.integration === "degraded" ? t("Cursor 接入需检查")
    : t("Cursor 尚未接管");
  return <div className={styles.connection} data-connected={enabled || undefined}>
    <Icon icon={connectionIcon} size="1.2em" />
    <div className={styles.connectionCopy}>
      <strong>{title}</strong>
      <span>{t("显示 {visible} / {total} 个模型 · 在 Cursor 对话中选择模型", { visible: visibleCount, total: modelCount })}</span>
    </div>
    <div className={styles.connectionActions}>
      <Button size="small" onClick={onAccounts}>{t("管理账号")}</Button>
      <Button size="small" disabled={busy || !status || (!taken && status.ca !== "ready")} onClick={() => onToggle(!taken)}>{taken ? t("暂停接入") : t("开启接入")}</Button>
    </div>
  </div>;
}
