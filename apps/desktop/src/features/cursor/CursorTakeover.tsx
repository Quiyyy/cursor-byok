import { useEffect, useId, useState } from "react";
import { api } from "../../shared/api";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Modal } from "../../shared/ui/Modal";
import { Switch } from "../../shared/ui/Switch";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { useMessage } from "../../shared/ui/message";
import styles from "./CursorTakeover.module.scss";

/** Cursor integration is global and remains available independently of the active page. */
export function CursorTakeover() {
  const { cursorHarness: status, cursorBusy, busy: refreshing } = useAppStore();
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

  const toggle = (enabled: boolean) => {
    const current = appStore.getSnapshot();
    if (current.cursorBusy || current.busy || !current.cursorHarness) return;
    if (enabled && current.cursorHarness.ca !== "ready") setSetupOpen(true);
    else void appStore.setCursorEnabled(enabled);
  };
  const initializeCa = async () => {
    const next = await appStore.initializeCursorCa();
    if (next?.ca === "ready") setSetupOpen(false);
    if (next?.ca === "untrusted" && next.ca_install_command) setCaCommand(next.ca_install_command);
  };
  const refreshCa = async () => {
    await appStore.refresh();
    setWaitingForCaRefresh(false);
    if (appStore.getSnapshot().cursorHarness?.ca === "ready") setSetupOpen(false);
  };
  const openCaTerminal = () => {
    if (caCommand) void api.openCursorCaInstallTerminal(caCommand).catch((cause) => message(errorText(cause)));
    setCaCommand(null);
    setWaitingForCaRefresh(true);
  };

  return <>
    <div className={styles.control} data-degraded={degraded || undefined}>
      <label htmlFor={switchId}>{t("Cursor 接管")}</label>
      <TooltipTrigger label={description}>
        <Switch id={switchId} className={styles.switch} label={t("Cursor 接管")} checked={checked} disabled={busy || !status} aria-busy={busy} onChange={toggle} />
      </TooltipTrigger>
    </div>
    <Modal open={setupOpen} title={t("准备 Cursor 接入")} onClose={() => setSetupOpen(false)} closeLabel={t("关闭")} busy={busy}>
      <div className={styles.setup}>
        <p>{t("模型配置和测试可独立完成。仅在接管 Cursor 时需要安装并信任本地证书。")}</p>
        <Button variant="primary" disabled={busy || !status} onClick={() => void (waitingForCaRefresh ? refreshCa() : initializeCa())}>
          {waitingForCaRefresh ? t("我已初始化，刷新") : status?.ca === "untrusted" ? t("打开终端安装 CA") : t("初始化 CA")}
        </Button>
        {!waitingForCaRefresh && <Button disabled={busy} onClick={() => void refreshCa()}>{t("刷新接入状态")}</Button>}
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
