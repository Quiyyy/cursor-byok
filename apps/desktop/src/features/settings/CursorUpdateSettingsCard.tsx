import { useEffect, useState } from "react";
import type { CursorUpdatePhase } from "../../shared/api";
import { cursorUpdateStore, useCursorUpdateStore } from "../cursor/updateState";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Switch } from "../../shared/ui/Switch";
import { TitledCard } from "../../shared/ui/TitledCard";
import styles from "./CursorUpdateSettingsCard.module.scss";

function phaseLabel(phase: CursorUpdatePhase) {
  switch (phase) {
    case "idle": return t("尚无待安装的已验证更新");
    case "unverified": return t("官方新版本尚未通过验收，未下载或安装");
    case "checking": return t("正在检查 Cursor 更新…");
    case "downloading": return t("正在下载官方安装包…");
    case "verifying": return t("正在验证安装包…");
    case "extracting": return t("正在准备兼容性检查…");
    case "validating": return t("正在检查接管兼容性…");
    case "ready": return t("已验证版本已准备好，可以更新");
    case "closing": return t("正在等待 Cursor 正常退出…");
    case "installing": return t("正在安装 Cursor 更新…");
    case "patching": return t("正在恢复并验证接管…");
    case "starting": return t("正在启动 Cursor…");
    case "complete": return t("Cursor 更新完成");
    case "failed": return t("Cursor 更新未完成");
  }
}

export function CursorUpdateSettingsCard() {
  const { status, pending, error } = useCursorUpdateStore();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmManagement, setConfirmManagement] = useState<boolean | null>(null);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  useEffect(() => { void cursorUpdateStore.refresh(); }, []);
  const busy = pending || Boolean(status?.busy);
  const cancellable = status?.can_cancel;
  const problem = error ?? status?.error;
  const megabytes = status ? (status.downloaded_bytes / 1024 / 1024).toFixed(1) : "0";
  return <TitledCard title={t("Cursor 版本管理")}>
    <div className={styles.content}>
      <div className={styles.row}>
        <div className={styles.description}>
          <strong>{t("由 BYOK 管理 Cursor 更新")}</strong>
          <small>{t("固定编辑器和内置 Harness，仅安装经过验收的官方版本。关闭后恢复原来的更新配置。")}</small>
        </div>
        <Switch label={t("由 BYOK 管理 Cursor 更新")} checked={status?.enabled ?? false} disabled={!status || (!status.supported && !status.enabled) || busy || status.recovery_required} onChange={setConfirmManagement} />
      </div>
      {!status ? error ? <Button size="small" onClick={() => void cursorUpdateStore.refresh()}>{t("重试")}</Button> : <small>{t("正在读取 Cursor 更新状态…")}</small> : <>
        <div className={styles.row}>
          <div className={styles.description}>
            <span>{status.current_version ? t("当前 Cursor 版本 {version}", { version: status.current_version }) : t("未找到受支持的 Cursor 安装")}</span>
            {status.verified_release && <small>{t("已验证组合：Cursor {version} · 内置 Harness", { version: status.verified_release.version })}</small>}
            {status.current_version && status.supported && !status.current_verified && <small>{t("当前版本未经验证；启用管理后会暂停原生接管，账号、模型管理和外部 API 仍可使用。")}</small>}
            {status.unverified_version && <small>{t("未提供安装的新版本：{version}", { version: status.unverified_version })}</small>}
            {status.candidate && <small>{t("候选版本 {version}", { version: status.candidate.version })}</small>}
            <small role="status">{pending && !status.busy ? t("处理中…") : status.supported ? phaseLabel(status.phase) : t("目前仅支持 Windows x64 稳定渠道的用户安装版。")}</small>
          </div>
          <div className={styles.actions}>
            {status.recovery_required
              ? <Button size="small" disabled={busy} onClick={() => setConfirmRecovery(true)}>{t("恢复接管")}</Button>
              : status.busy && cancellable
                ? <Button size="small" disabled={pending} onClick={() => void cursorUpdateStore.cancel()}>{t("取消检查")}</Button>
                : <>
                  <Button size="small" disabled={!status.supported || busy} onClick={() => void cursorUpdateStore.check()}>{t("检查更新")}</Button>
                  {status.candidate && <Button size="small" variant="primary" disabled={busy || !status.enabled} onClick={() => setConfirmId(status.candidate!.id)}>{t("更新并重启 Cursor")}</Button>}
                </>}
          </div>
        </div>
        {status.phase === "downloading" && <div className={styles.download}>
          <progress aria-label={t("Cursor 安装包下载进度")} value={status.total_bytes ? status.downloaded_bytes : undefined} max={status.total_bytes ?? undefined} />
          <small>{status.total_bytes ? t("已下载 {downloaded} / {total} MB", { downloaded: megabytes, total: (status.total_bytes / 1024 / 1024).toFixed(1) }) : t("已下载 {downloaded} MB", { downloaded: megabytes })}</small>
        </div>}
      </>}
      {problem && <small role="alert" className={styles.error}>{problem}</small>}
      {status?.recovery_required && <small>{t("检测到中断的更新。先恢复接管，再进行新的更新。")}</small>}
    </div>
    <ConfirmDialog open={confirmRecovery} title={t("恢复 Cursor 更新")} cancelLabel={t("取消")} confirmLabel={t("确认恢复")} busy={busy} onCancel={() => setConfirmRecovery(false)} onConfirm={() => { setConfirmRecovery(false); void cursorUpdateStore.recover(); }}>
      <p>{t("将检查上次安装状态。尚未完成的安装会使用已验证安装包重试；已完成的安装只恢复接管并启动 Cursor。请先保存工作。")}</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirmManagement !== null} title={confirmManagement ? t("启用 Cursor 版本管理") : t("关闭 Cursor 版本管理")} cancelLabel={t("取消")} confirmLabel={t("确认并应用")} busy={busy} onCancel={() => setConfirmManagement(null)} onConfirm={() => {
      const enabled = confirmManagement; setConfirmManagement(null); if (enabled !== null) void cursorUpdateStore.configure(enabled);
    }}>
      <p>{t("请先保存 Cursor 中的工作。若 Cursor 正在运行，会请求正常退出并重新打开，以应用编辑器和 Harness 更新设置；取消退出将保留原配置。")}</p>
      <p>{t("此操作不会安装或降级 Cursor。新版本仍需单独检查并确认安装。")}</p>
    </ConfirmDialog>
    <ConfirmDialog open={confirmId !== null} title={t("更新并重启 Cursor")} cancelLabel={t("取消")} confirmLabel={t("开始更新")} busy={busy} onCancel={() => setConfirmId(null)} onConfirm={() => {
      const id = confirmId; setConfirmId(null); if (id) void cursorUpdateStore.install(id);
    }}>
      <p>{t("请先保存 Cursor 中的工作。应用会请求 Cursor 正常退出，更新并恢复接管后再启动一次；如果你取消退出，更新也会停止。")}</p>
    </ConfirmDialog>
  </TitledCard>;
}
