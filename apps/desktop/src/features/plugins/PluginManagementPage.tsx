import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, pluginText, type PluginDescriptor, type PluginImportFile, type PluginRuntimePhase, type PluginRuntimeStatus } from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { PageContent } from "../../shell/layout/PageContent";
import { useSettingsStore } from "../settings/state";
import { pluginsStore, usePluginsStore } from "./state";
import { ActionMenu, type ActionMenuItem } from "../../shared/ui/ActionMenu";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { Modal } from "../../shared/ui/Modal";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { PluginAddPanel } from "./PluginResourcePanels";
import { PluginSettingsModal, type PluginSettingsTab } from "./PluginSettingsModal";
import { TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import styles from "./PluginManagementPage.module.scss";

export function PluginManagementPage() {
  const { pluginRuntime, plugins } = usePluginsStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [progressOpen, setProgressOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [selected, setSelected] = useState<{ pluginId: string; mode: "add" | PluginSettingsTab; providerId?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const requestedPlugin = params.get("plugin");
  const requestedTab = params.get("tab") === "models" ? "models" : "accounts";
  const requestedProvider = params.get("provider") ?? undefined;
  const handledRequest = useRef("");
  const cancelRequested = useRef(false);
  const selectedPlugin = selected ? plugins.find((plugin) => plugin.id === selected.pluginId) ?? null : null;

  useEffect(() => {
    const key = requestedPlugin ? `${requestedPlugin}:${requestedTab}:${requestedProvider ?? ""}` : "";
    if (!key) handledRequest.current = "";
    if (key !== handledRequest.current && requestedPlugin && plugins.some((plugin) => plugin.id === requestedPlugin)) {
      handledRequest.current = key;
      setSelected({ pluginId: requestedPlugin, mode: requestedTab, providerId: requestedProvider });
    }
  }, [requestedPlugin, requestedTab, requestedProvider, plugins]);
  const onConfigured = useCallback((syncError?: string) => {
    if (syncError) message(t("账号已保存，但同步模型失败：{error}", { error: syncError }), { duration: 5000 });
    setSelected((current) => {
      if (!current) return null;
      const plugin = pluginsStore.getSnapshot().plugins.find((candidate) => candidate.id === current.pluginId);
      return { ...current, mode: plugin?.providers.some((provider) => provider.hasModels) ? "models" : "accounts" };
    });
  }, [message]);
  const closeSelected = () => {
    setSelected(null);
    if (requestedPlugin) setParams({}, { replace: true });
  };

  useEffect(() => {
    if (!pluginRuntime) void pluginsStore.refreshPluginRuntime();
  }, [pluginRuntime]);

  useEffect(() => {
    if (pluginRuntime?.state !== "initializing") return;
    if (!cancelRequested.current) setProgressOpen(true);
    const timer = window.setInterval(() => void pluginsStore.refreshPluginRuntime(), 300);
    return () => window.clearInterval(timer);
  }, [pluginRuntime?.state]);

  const initialize = async () => {
    if (starting) return;
    cancelRequested.current = false;
    setStarting(true);
    setProgressOpen(true);
    const status = await pluginsStore.initializePluginRuntime();
    setStarting(false);
    if (!status) {
      setProgressOpen(false);
    } else if (cancelRequested.current && status.state === "initializing") {
      void pluginsStore.cancelPluginRuntimeInitialization();
    }
  };

  const closeProgress = () => {
    setProgressOpen(false);
    cancelRequested.current = true;
    if (pluginRuntime?.state === "initializing") {
      void pluginsStore.cancelPluginRuntimeInitialization();
    }
  };

  const visiblePlugins = plugins.filter((plugin) => {
    const accounts = plugin.resources.flatMap((resource) => resource.resources);
    const connected = accounts.length > 0 || plugin.providers.some((provider) => provider.configured);
    const attention = accounts.some((account) => account.state.status !== "ready");
    const searchable = [plugin.name, ...plugin.providers.map((provider) => pluginText(provider.displayName, locale)), ...accounts.map((account) => account.displayName)].join(" ");
    return searchable.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      && (filter === "all" || (filter === "connected" ? connected : attention));
  });

  return <>
    <PageActions><Button onClick={() => navigate("/models")}>{t("查看模型")}</Button></PageActions>
    {pluginRuntime?.state === "ready" && <PageActions position="filters"><div className={styles.toolbar}>
      <TextInput aria-label={t("搜索服务或账号")} placeholder={t("搜索服务或账号")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <Select ariaLabel={t("连接状态")} value={filter} onChange={setFilter} options={[
        { value: "all", label: t("全部服务") },
        { value: "connected", label: t("已连接") },
        { value: "attention", label: t("需要处理") },
      ]} />
    </div></PageActions>}
    <PageContent
      title={t("账号连接")}
      sections={pluginRuntime?.state !== "ready"
        ? [{ key: "runtime", estimatedHeight: 250, content: <RuntimeGate status={pluginRuntime} starting={starting} onInitialize={() => void initialize()} /> }]
        : visiblePlugins.length
          ? visiblePlugins.map((plugin) => ({ key: plugin.id, estimatedHeight: 96, content: <PluginCard plugin={plugin} onOpen={(pluginId, mode) => setSelected({ pluginId, mode })} /> }))
          : [{ key: "empty", estimatedHeight: 180, content: <div className={styles.empty}><strong>{plugins.length ? t("没有匹配的服务或账号") : t("还没有安装插件")}</strong>{plugins.length > 0 && <Button onClick={() => { setQuery(""); setFilter("all"); }}>{t("清除筛选")}</Button>}</div> }]}
    />
    <RuntimeProgressModal
      open={progressOpen}
      status={pluginRuntime}
      starting={starting}
      onClose={closeProgress}
    />
    {selectedPlugin && selected?.mode !== "add" && <PluginSettingsModal
      key={`${selectedPlugin.id}:${selected?.mode}:${selected?.providerId ?? ""}`}
      plugin={selectedPlugin}
      initialTab={selected?.mode ?? "accounts"}
      initialProviderId={selected?.providerId}
      onAdd={() => setSelected({ pluginId: selectedPlugin.id, mode: "add" })}
      onClose={closeSelected}
    />}
    <Modal
      fullHeight
      open={selectedPlugin !== null && selected?.mode === "add"}
      title={t("添加 {name} 账号", { name: selectedPlugin?.name ?? "" })}
      onClose={closeSelected}
      closeLabel={t("关闭")}
    >
      {selected?.mode === "add" && selectedPlugin && <PluginAddPanel plugin={selectedPlugin} onConfigured={onConfigured} />}
    </Modal>
  </>;
}

function RuntimeGate({ status, starting, onInitialize }: { status: PluginRuntimeStatus | null; starting: boolean; onInitialize: () => void }) {
  const checking = status === null;
  const initializing = starting || status?.state === "initializing";
  const failed = status?.state === "failed";
  const unsupported = status?.state === "unsupported";
  const title = checking
    ? t("正在检查插件运行时")
    : failed
      ? t("插件运行时初始化失败")
      : unsupported
        ? t("当前系统不支持插件运行时")
        : t("准备账号连接");
  const description = failed
    ? t("请重试初始化")
    : unsupported
      ? status.error ?? t("当前操作系统或 CPU 架构暂不受支持")
      : t("首次使用需下载运行组件。");

  return <div className={styles.gate}>
    <strong>{title}</strong>
    <span>{description}</span>
    {!unsupported && <Button variant="primary" disabled={checking || initializing} onClick={onInitialize}>
      {checking ? t("检查中…") : initializing ? t("初始化中…") : failed ? t("重新初始化插件") : t("准备账号连接")}
    </Button>}
  </div>;
}

function PluginCard({ plugin, onOpen }: {
  plugin: PluginDescriptor;
  onOpen: (pluginId: string, mode: "add" | PluginSettingsTab) => void;
}) {
  const { locale } = useI18n();
  const { ports } = useSettingsStore();
  const message = useMessage();
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const accountCount = plugin.resources.reduce((count, resource) => count + resource.resources.length, 0);
  const configured = plugin.providers.some((provider) => provider.configured);
  const accounts = plugin.resources.flatMap((resource) => resource.resources);
  const invalidCount = accounts.filter((resource) => resource.state.status === "invalid").length;
  const coolingCount = accounts.filter((resource) => resource.state.status === "cooling").length;
  const readyCount = accounts.filter((resource) => resource.state.status === "ready").length;
  const modelCount = plugin.providers.reduce((count, provider) => count + provider.models.length, 0);
  const enabledCount = plugin.providers.reduce((count, provider) => count + provider.models.filter((model) => model.enabled).length, 0);
  const needsAttention = invalidCount > 0 || coolingCount > 0;
  const canAdd = plugin.resources.some((resource) => resource.add.length > 0);
  const hasModels = plugin.providers.some((provider) => provider.hasModels);
  const subtitle = plugin.providers.map((provider) => pluginText(provider.displayName, locale)).join(" · ") || plugin.id;
  const importResource = plugin.resources.find((resource) => resource.import);
  const exportResource = plugin.resources.find((resource) => resource.resources.length > 0);

  const importFiles = async (files: FileList | null) => {
    if (!files?.length || !importResource) return;
    setImporting(true);
    try {
      const entries: PluginImportFile[] = await Promise.all(
        [...files].map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      const result = await api.importPluginResources(plugin.id, importResource.type, entries);
      await pluginsStore.refreshPlugins();
      const summary = t("导入完成：新增 {added}，更新 {updated}", { added: result.added, updated: result.updated });
      if (result.modelSyncError) {
        message(t("账号已保存，但同步模型失败：{error}", { error: result.modelSyncError }), { duration: 5000 });
      } else if (result.warnings.length > 0) {
        message(`${summary} · ${result.warnings.join("; ")}`, { duration: 5000 });
      } else {
        message(summary);
      }
      onOpen(plugin.id, hasModels ? "models" : "accounts");
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause), { duration: 5000 });
    } finally {
      setImporting(false);
      if (importInput.current) importInput.current.value = "";
    }
  };

  const moreItems: ActionMenuItem[] = [
    ...(canAdd && accountCount > 0 ? [{ id: "add-account", label: t("添加账号"), onSelect: () => onOpen(plugin.id, "add") }] : []),
    ...(plugin.author ? [{ id: "author", type: "text" as const, label: plugin.author }] : []),
    ...(importResource
      ? [
          {
            id: "import",
            label: importing ? t("正在导入…") : t("批量导入"),
            disabled: importing,
            onSelect: () => importInput.current?.click(),
          },
        ]
      : []),
    ...(exportResource
      ? [
          {
            id: "export",
            label: t("批量导出"),
            onSelect: () =>
              void api.openExternalUrl(
                api.pluginResourceExportUrl(
                  ports.service_port,
                  plugin.id,
                  exportResource.type,
                ),
              ).catch((cause) => message(cause instanceof Error ? cause.message : String(cause))),
          },
        ]
      : []),
    ...(plugin.version
      ? [{ id: "version", type: "text" as const, label: `v${plugin.version}` }]
      : []),
  ];

  return (
    <Card className={styles.pluginCard} data-attention={invalidCount ? "invalid" : coolingCount ? "cooling" : undefined}>
      <div className={styles.pluginCardTop}>
        <img className={styles.pluginIcon} src={plugin.icon} alt="" />
        <div className={styles.pluginIdentity}>
          <div className={styles.nameRow}><span className={styles.pluginName} title={subtitle}>{plugin.name}</span>
          <span
          className={`${styles.stateBadge} ${needsAttention ? styles.stateAttention : readyCount > 0 || configured ? styles.stateReady : ""}`}
        >
          {invalidCount > 0 ? t("需重新授权") : coolingCount > 0 ? t("账号冷却中") : readyCount > 0 ? t("已连接") : configured ? t("已配置") : t("未连接")}
          </span></div>
          <span className={styles.pluginMeta}>
          {t("{accounts} 个账号 · 已添加 {enabled} / {models} 个模型", {
            accounts: accountCount,
            enabled: enabledCount,
            models: modelCount,
          })}
          </span>
          {needsAttention && <span className={styles.accountNotice}>{t("可用 {ready} · 冷却 {cooling} · 失效 {invalid}", { ready: readyCount, cooling: coolingCount, invalid: invalidCount })}</span>}
        </div>
      </div>
      <div className={styles.cardActions}>
        <Button
          size="small"
          variant={accountCount > 0 || !canAdd ? "secondary" : "primary"}
          onClick={() => onOpen(plugin.id, accountCount > 0 || !canAdd ? "accounts" : "add")}
        >{accountCount > 0 || !canAdd ? t("管理账号") : t("连接账号")}</Button>
        {hasModels && <Button variant="ghost" size="small" onClick={() => onOpen(plugin.id, "models")}>{t("模型目录")}</Button>}
        {moreItems.length > 0 && (
          <span className={styles.moreAction}>
            <ActionMenu iconOnly label={t("更多")} items={moreItems} />
          </span>
        )}
        {importResource && (
          <input
            ref={importInput}
            type="file"
            hidden
            accept={importResource.import?.accept.join(",")}
            multiple={importResource.import?.multiple ?? false}
            onChange={(event) => void importFiles(event.target.files)}
          />
        )}
      </div>
    </Card>
  );
}

function RuntimeProgressModal({ open, status, starting, onClose }: { open: boolean; status: PluginRuntimeStatus | null; starting: boolean; onClose: () => void }) {
  const initializing = starting || status?.state === "initializing";
  const downloaded = status?.downloaded_bytes ?? 0;
  const total = status?.total_bytes ?? null;
  const percent = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  const stage = status?.state === "ready"
    ? t("插件运行时初始化完成")
    : status?.state === "failed"
      ? t("插件运行时初始化失败")
      : phaseText(status?.phase ?? null);

  return <Modal
    open={open}
    title={t("初始化插件运行时")}
    closeLabel={status?.state === "ready" ? t("完成") : initializing ? t("取消") : t("关闭")}
    onClose={onClose}
  >
    <div className={styles.progressContent} aria-live="polite">
      <strong>{stage}</strong>
      {status?.phase === "downloading" && <>
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-label={t("下载进度")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <div
            className={styles.progressFill}
            style={{ width: `${percent ?? 100}%` }}
          />
        </div>
        <span>
          {total ? t("已下载 {downloaded} / {total}", { downloaded: formatBytes(downloaded), total: formatBytes(total) }) : t("已下载 {downloaded}", { downloaded: formatBytes(downloaded) })}
        </span>
      </>}
      {status?.state === "failed" && <span className={styles.error}>{t("请重试初始化")}</span>}
      {status?.state === "ready" && <span>{t("插件运行时 {version} 已安装，可以开始使用插件。", { version: status.version })}</span>}
    </div>
  </Modal>;
}

function phaseText(phase: PluginRuntimePhase | null) {
  switch (phase) {
    case "checking": return t("正在检查插件运行时");
    case "downloading": return t("正在下载插件运行时");
    case "verifying": return t("正在验证插件运行时下载文件");
    case "installing": return t("正在安装插件运行时");
    case "validating": return t("正在验证插件运行时");
    default: return t("正在准备插件运行时");
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}
