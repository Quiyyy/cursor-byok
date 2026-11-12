import { useEffect, useId, useState } from "react";
import { api, type CaState, type IntegrationState } from "../../shared/api";
import { cursorStore, useCursorStore } from "./state";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Icon } from "../../shared/ui/Icon";
import { informationOutlineIcon } from "../../shared/ui/icons";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { useMessage } from "../../shared/ui/message";
import styles from "./CursorTakeover.module.scss";

function caStatusLabel(ca: CaState) {
  switch (ca) {
    case "ready": return t("已信任");
    case "untrusted": return t("待安装信任");
    case "invalid": return t("证书异常");
    default: return t("未初始化");
  }
}

function integrationStatusLabel(integration: IntegrationState, settingsApplied: boolean) {
  if (integration === "enabled") return t("正常生效");
  if (integration === "degraded" || settingsApplied) return t("部分生效，需检查");
  return t("未启用");
}

/** Cursor integration is global and remains available independently of the active page. */
export function CursorTakeover() {
  const { cursorHarness: status, cursorBusy, busy: refreshing, error } = useCursorStore();
  const message = useMessage();
  const switchId = useId();
  const [setupOpen, setSetupOpen] = useState(false);
  const [caCommand, setCaCommand] = useState<string | null>(null);
  const [waitingForCaRefresh, setWaitingForCaRefresh] = useState(false);
  const busy = cursorBusy || refreshing;
  // A partially active proxy must still be switchable off.
  const checked = Boolean(status && (status.integration !== "disabled" || status.settings_applied));
  const degraded = checked && (status?.integration !== "enabled" || status.ca !== "ready");
  const description = !status ? t("正在检查接入") : busy ? t("处理中…")
    : degraded ? t("Cursor 接入需检查") : checked ? t("Cursor 已接管")
    : status.ca !== "ready" ? t("准备 Cursor 接入") : t("Cursor 未接管");

  useEffect(() => {
    if (caCommand) void api.copyCursorText(caCommand).catch((cause) => message(errorText(cause)));
  }, [caCommand, message]);

  const reportStoreError = () => {
    const nextError = cursorStore.getSnapshot().error;
    if (nextError) message(nextError, { duration: 5000 });
  };

  const toggle = async (enabled: boolean) => {
    const current = cursorStore.getSnapshot();
    if (current.cursorBusy || current.busy || !current.cursorHarness) return;
    if (enabled && current.cursorHarness.ca !== "ready") {
      setSetupOpen(true);
      return;
    }
    const updated = await cursorStore.setCursorEnabled(enabled);
    if (!updated) reportStoreError();
  };
  const initializeCa = async () => {
    const next = await cursorStore.initializeCursorCa();
    if (!next) {
      reportStoreError();
      return;
    }
    if (next.ca === "ready" && !degraded) setSetupOpen(false);
    if (next.ca === "untrusted" && next.ca_install_command) setCaCommand(next.ca_install_command);
  };
  const refreshCa = async () => {
    await cursorStore.refresh();
    setWaitingForCaRefresh(false);
    const snapshot = cursorStore.getSnapshot();
    if (snapshot.error) {
      message(snapshot.error, { duration: 5000 });
      return;
    }
    if (snapshot.cursorHarness?.ca === "ready" && snapshot.cursorHarness.integration !== "degraded") {
      setSetupOpen(false);
    }
  };
  const reapplyTakeover = async () => {
    const updated = await cursorStore.setCursorEnabled(true);
    if (!updated) {
      reportStoreError();
      return;
    }
    const next = cursorStore.getSnapshot().cursorHarness;
    if (next?.ca === "ready" && next.integration === "enabled") setSetupOpen(false);
  };
  const openCaTerminal = () => {
    if (caCommand) void api.openCursorCaInstallTerminal(caCommand).catch((cause) => message(errorText(cause)));
    setCaCommand(null);
    setWaitingForCaRefresh(true);
  };

  return <>
    <div className={styles.control} data-degraded={degraded || undefined}>
      <div className={styles.labelGroup}>
        <label htmlFor={switchId}>{t("Cursor 接管")}</label>
        {degraded && <TooltipTrigger label={t("查看接入诊断")}>
          <button
            type="button"
            className={styles.inspectButton}
            aria-label={t("查看接入诊断")}
            disabled={busy}
            onClick={() => setSetupOpen(true)}
          >
            <Icon icon={informationOutlineIcon} size="1.05em" />
          </button>
        </TooltipTrigger>}
      </div>
      {!status && error ? <Button id={switchId} variant="ghost" size="small" aria-label={t("刷新接入状态")} disabled={busy} onClick={() => void refreshCa()}>
        {t("刷新")}
      </Button> : <TooltipTrigger label={description}>
        <Switch id={switchId} className={styles.switch} label={t("Cursor 接管")} checked={checked} disabled={busy || !status} aria-busy={busy} onChange={(next) => void toggle(next)} />
      </TooltipTrigger>}
    </div>
    <Modal
      compact
      open={setupOpen}
      title={degraded ? t("检查 Cursor 接入") : t("准备 Cursor 接入")}
      banner={error ? <span className={styles.error} role="alert">{error}</span> : undefined}
      onClose={() => setSetupOpen(false)}
      closeLabel={t("关闭")}
      busy={busy}
    >
      <div className={styles.setup}>
        <p className={styles.setupHint}>{t("模型配置和测试可独立完成。仅在接管 Cursor 时需要安装并信任本地证书。")}</p>
        {status && <div className={styles.statusList}>
          <div className={styles.statusItem}>
            <span>{t("本地证书")}</span>
            <strong data-warn={status.ca !== "ready" || undefined}>{caStatusLabel(status.ca)}</strong>
          </div>
          <div className={styles.statusItem}>
            <span>{t("Cursor 配置")}</span>
            <strong data-warn={degraded || undefined}>{integrationStatusLabel(status.integration, status.settings_applied)}</strong>
          </div>
        </div>}
        <div className={styles.setupActions}>
          {status?.ca === "ready" && degraded ? (
            <Button variant="primary" disabled={busy} onClick={() => void reapplyTakeover()}>{t("重新应用接管")}</Button>
          ) : (
            <Button variant="primary" disabled={busy || !status} onClick={() => void (waitingForCaRefresh ? refreshCa() : initializeCa())}>
              {waitingForCaRefresh ? t("我已初始化，刷新") : status?.ca === "untrusted" ? t("打开终端安装 CA") : t("初始化 CA")}
            </Button>
          )}
          {!waitingForCaRefresh && <Button disabled={busy} onClick={() => void refreshCa()}>{t("刷新接入状态")}</Button>}
        </div>
      </div>
    </Modal>
    <ConfirmDialog open={caCommand !== null} title={t("安装本地 CA")} cancelLabel={t("关闭")} confirmLabel={t("打开终端")} onCancel={() => setCaCommand(null)} onConfirm={openCaTerminal}>
      <div className={styles.setup}>
        <strong>{t("需要授权安装证书")}</strong>
        <span>{t("安装命令已自动复制。点击“打开终端”，将命令粘贴到终端中执行，并按提示输入密码。")}</span>
        <pre className={styles.command}>{caCommand}</pre>
      </div>
    </ConfirmDialog>
  </>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
