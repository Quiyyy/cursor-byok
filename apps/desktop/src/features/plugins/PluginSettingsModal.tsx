import { useRef, useState } from "react";
import { api, pluginText, type PluginDescriptor } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { useI18n } from "../../i18n/store";
import { Button } from "../../shared/ui/Button";
import { Checkbox } from "../../shared/ui/Checkbox";
import { TextInput } from "../../shared/ui/FormControls";
import { Modal } from "../../shared/ui/Modal";
import { Select } from "../../shared/ui/Select";
import { PluginAccountsPanel } from "./PluginResourcePanels";
import styles from "./PluginSettingsModal.module.scss";

export type PluginSettingsTab = "accounts" | "models";
const PAGE_SIZE = 8;

export function PluginSettingsModal({ plugin, initialTab, initialProviderId, onAdd, onClose }: {
  plugin: PluginDescriptor;
  initialTab: PluginSettingsTab;
  initialProviderId?: string;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const [tab, setTab] = useState(initialTab);
  const [providerId, setProviderId] = useState(initialProviderId ?? "");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [operation, setOperation] = useState<"save" | "sync" | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const providers = plugin.providers.filter((candidate) => candidate.hasModels);
  const provider = providers.find((candidate) => candidate.id === providerId) ?? providers[0];
  const canSync = provider && (!provider.resourceType || plugin.resources.some((resource) =>
    resource.type === provider.resourceType && resource.resources.length > 0));
  const allModels = providers.flatMap((candidate) => candidate.models.map((model) => ({ provider: candidate, model })));
  const pending = allModels.filter(({ model }) => changes[model.id] !== undefined && changes[model.id] !== model.enabled);
  const filtered = (provider?.models ?? []).filter((model) =>
    `${model.displayName} ${model.modelId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const busy = operation !== null || accountBusy;
  const canAdd = plugin.resources.some((resource) => resource.add.length > 0);

  const run = async (nextOperation: "save" | "sync", task: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setOperation(nextOperation);
    setError(null);
    try {
      await task();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      // Refresh even on partial failure; remaining unsaved choices stay available for retry.
      await appStore.refreshPlugins();
      running.current = false;
      setOperation(null);
    }
  };
  const save = async () => {
    const saved = await run("save", async () => {
      for (const { provider: target, model } of pending) {
        await api.setPluginModelEnabled(plugin.id, target.id, model.modelId, changes[model.id]);
      }
    });
    if (saved) setChanges({});
  };
  const setFiltered = (enabled: boolean) => {
    setChanges((current) => ({
      ...current,
      ...Object.fromEntries(filtered.map((model) => [model.id, enabled])),
    }));
  };

  return <Modal
    fullHeight
    open
    title={plugin.name}
    busy={busy}
    onClose={onClose}
    closeLabel={pending.length ? t("取消更改") : t("关闭")}
    onSubmit={tab === "models" ? () => void save() : undefined}
    submitLabel={t("保存模型选择")}
    submitDisabled={pending.length === 0}
    secondaryAction={canAdd && <Button disabled={busy || pending.length > 0} onClick={onAdd}>{t("添加账号")}</Button>}
    banner={<div className={styles.banner}>
      <div className={styles.tabs} role="group" aria-label={t("管理视图")}>
        <button type="button" aria-pressed={tab === "accounts"} disabled={busy} onClick={() => setTab("accounts")}>{t("账号")}</button>
        <button type="button" aria-pressed={tab === "models"} disabled={busy || providers.length === 0} onClick={() => setTab("models")}>{t("模型目录")}{pending.length > 0 && ` · ${pending.length}`}</button>
      </div>
      {tab === "models" && provider && <>
        <div className={styles.toolbar}>
          {providers.length > 1
            ? <Select ariaLabel={t("模型通道")} value={provider.id} options={providers.map((candidate) => ({ value: candidate.id, label: pluginText(candidate.displayName, locale) }))} disabled={busy} onChange={(value) => { setProviderId(value); setQuery(""); setPage(1); }} />
            : <span>{pluginText(provider.displayName, locale)}</span>}
          <Button size="small" disabled={busy || !canSync || pending.length > 0} onClick={() => void run("sync", async () => { await api.syncPluginModels(plugin.id, provider.id); })}>{operation === "sync" ? t("正在同步…") : t("同步模型")}</Button>
        </div>
        <div className={styles.toolbar}>
          <TextInput aria-label={t("搜索模型")} placeholder={t("搜索模型")} value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
          <Button size="small" disabled={busy || !filtered.length} onClick={() => setFiltered(true)}>{t("添加筛选结果")}</Button>
          <Button size="small" disabled={busy || !filtered.length} onClick={() => setFiltered(false)}>{t("移除筛选结果")}</Button>
        </div>
        <span className={styles.summary} aria-live="polite">
          {pending.length ? t("{count} 项更改待保存", { count: pending.length }) : t("勾选要添加到模型管理的模型，保存后生效。")}
        </span>
      </>}
      {error && <span className={styles.error} role="alert">{error}</span>}
    </div>}
  >
    {tab === "accounts"
      ? <PluginAccountsPanel plugin={plugin} onBusyChange={setAccountBusy} />
      : <div className={styles.catalog}>
        {visible.map((model) => <div className={styles.model} key={model.id}>
          <Checkbox checked={changes[model.id] ?? model.enabled} disabled={busy} label={model.displayName} onChange={(enabled) => setChanges((current) => ({ ...current, [model.id]: enabled }))} />
          <span>{model.modelId}</span>
        </div>)}
        {!visible.length && <p className={styles.empty}>{query.trim() ? t("没有匹配的模型") : canSync ? t("尚未同步模型") : t("连接账号后可同步模型目录。")}</p>}
        {pageCount > 1 && <div className={styles.pagination}>
          <Button size="small" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{t("上一页")}</Button>
          <span>{t("第 {page} / {total} 页", { page: currentPage, total: pageCount })}</span>
          <Button size="small" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>{t("下一页")}</Button>
        </div>}
      </div>}
  </Modal>;
}
