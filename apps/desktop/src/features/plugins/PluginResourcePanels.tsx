import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  pluginText,
  type PluginAddMethod,
  type PluginDescriptor,
  type PluginOAuthBegin,
  type PluginResourceAction,
  type PluginResourceActionCard,
  type PluginResourceActionResult,
  type PluginResourceDescriptor,
  type PluginResourceView,
} from "../../shared/api";
import { useI18n } from "../../i18n/store";
import { pluginsStore } from "./state";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Modal } from "../../shared/ui/Modal";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import { Select } from "../../shared/ui/Select";
import styles from "./PluginResourcePanels.module.scss";

const PAGE_SIZE = 10;

export function PluginAddPanel({ plugin, onConfigured }: { plugin: PluginDescriptor; onConfigured: (syncError?: string) => void }) {
  return <div className={styles.panel}>
    {plugin.resources.map((resource) => <ResourceAddSection
      key={resource.type}
      plugin={plugin}
      resource={resource}
      onConfigured={onConfigured}
    />)}
    {plugin.resources.length === 0 && <span className={styles.empty}>{t("该插件不需要添加资源")}</span>}
  </div>;
}

function ResourceAddSection({ plugin, resource, onConfigured }: {
  plugin: PluginDescriptor;
  resource: PluginResourceDescriptor;
  onConfigured: (syncError?: string) => void;
}) {
  return <>
    {resource.add.map((method) => <OAuthMethodCard
      key={method.id}
      pluginId={plugin.id}
      resourceType={resource.type}
      resources={resource.resources}
      method={method}
      onConfigured={onConfigured}
    />)}
  </>;
}

function OAuthMethodCard({ pluginId, resourceType, resources, method, onConfigured }: {
  pluginId: string;
  resourceType: string;
  resources: PluginResourceView[];
  method: PluginAddMethod;
  onConfigured: (syncError?: string) => void;
}) {
  const { locale } = useI18n();
  const [status, setStatus] = useState<"idle" | "starting" | "polling" | "success" | "error">("idle");
  const [begun, setBegun] = useState<PluginOAuthBegin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [resourceId, setResourceId] = useState("");
  const stopped = useRef(false);

  const copyCode = async (code: string) => {
    await api.copyCursorText(code).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    stopped.current = false;
    return () => { stopped.current = true; };
  }, []);

  useEffect(() => {
    if (!begun) return;
    return () => { void api.pluginOAuthCancel(begun.sessionId).catch(() => undefined); };
  }, [begun]);

  useEffect(() => {
    if (!begun || status !== "polling") return;
    let timer = 0;
    const controller = new AbortController();
    const poll = async (intervalMs: number) => {
      if (stopped.current || controller.signal.aborted) return;
      try {
        const result = await api.pluginOAuthPoll(begun.sessionId, controller.signal);
        if (stopped.current || controller.signal.aborted) return;
        if (result.status === "pending") {
          timer = window.setTimeout(() => void poll(result.pollIntervalMs), Math.max(1000, result.pollIntervalMs));
          return;
        }
        if (result.status === "completed") {
          await pluginsStore.refreshPlugins();
          if (stopped.current || controller.signal.aborted) return;
          setStatus("success");
          onConfigured(result.modelSyncError ?? undefined);
          return;
        }
        setStatus("error");
        setError(result.message || t("授权被拒绝或已失败。"));
        await pluginsStore.refreshPlugins();
      } catch (cause) {
        if (stopped.current || controller.signal.aborted) return;
        setError(errorText(cause));
        timer = window.setTimeout(() => void poll(intervalMs), Math.max(1000, intervalMs));
      }
    };
    timer = window.setTimeout(() => void poll(begun.pollIntervalMs), Math.max(1000, begun.pollIntervalMs));
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [begun, onConfigured, status]);

  const start = async () => {
    setStatus("starting");
    setError(null);
    try {
      const next = await api.pluginOAuthBegin(pluginId, resourceType, method.id, resourceId || undefined);
      if (stopped.current) { await api.pluginOAuthCancel(next.sessionId); return; }
      setBegun(next);
      setStatus("polling");
      if (next.userCode) await api.copyCursorText(next.userCode).catch(() => undefined);
      await api.openExternalUrl(next.verificationUrlComplete || next.verificationUrl);
    } catch (cause) {
      setStatus("error");
      setError(errorText(cause));
    }
  };

  const userCode = begun?.userCode;
  return <Card className={styles.methodCard}>
    <strong>{pluginText(method.displayName, locale)}</strong>
    {method.description && <span>{pluginText(method.description, locale)}</span>}
    {method.canRegister && resources.length > 0 && <Select
      ariaLabel={t("授权账号")}
      value={resourceId}
      disabled={status === "starting" || status === "polling"}
      onChange={setResourceId}
      options={[{ value: "", label: t("添加另一个账号或工作区") }, ...resources.map(item => ({ value: item.id, label: item.displayName }))]}
    />}
    {userCode && status === "polling" && <div className={styles.deviceCode}>
      <small>{t("设备验证码")}</small>
      <button type="button" onClick={() => void copyCode(userCode)}>{userCode}</button>
      <button type="button" className={styles.copy} onClick={() => void copyCode(userCode)}>
        {copied ? t("已复制") : t("复制")}
      </button>
    </div>}
    <div className={styles.actions}>
      <Button variant="primary" disabled={status === "starting" || status === "polling"} onClick={() => void start()}>
        {status === "starting" ? t("正在申请授权码…") : status === "polling" ? t("等待网页端确认授权中…") : method.canRegister ? pluginText(method.displayName, locale) : t("开始登录")}
      </Button>
      {begun && status === "polling" && <Button onClick={() => void api.openExternalUrl(begun.verificationUrlComplete || begun.verificationUrl)}>{t("打开授权网页")}</Button>}
      {begun && status === "polling" && <Button onClick={() => { setStatus("idle"); setBegun(null); }}>{t("取消")}</Button>}
    </div>
    {status === "success" && <span className={styles.success}>{t("账号已保存，模型目录已同步。")}</span>}
    {error && <span className={styles.error} role="alert">{error}</span>}
  </Card>;
}

export function PluginAccountsPanel({ plugin, onBusyChange }: { plugin: PluginDescriptor; onBusyChange: (busy: boolean) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resourceAction, setResourceAction] = useState<{
    resource: PluginResourceDescriptor;
    item: PluginResourceView;
  } | null>(null);
  const [resourceActionResult, setResourceActionResult] = useState<PluginResourceActionResult | null>(null);
  const [resourceActionError, setResourceActionError] = useState<string | null>(null);
  useEffect(() => {
    onBusyChange(busy !== null);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await task();
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      await pluginsStore.refreshPlugins();
      setBusy(null);
    }
  };

  const executeResourceAction = async (
    target: { resource: PluginResourceDescriptor; item: PluginResourceView },
    action: PluginResourceAction,
    input: unknown = {},
  ) => {
    const key = `action:${target.item.id}:${action.id}`;
    setBusy(key);
    setResourceActionError(null);
    try {
      const result = await api.pluginResourceAction(
        plugin.id,
        target.resource.type,
        target.item.id,
        action.id,
        input,
      );
      setResourceActionResult(result);
      await pluginsStore.refreshPlugins();
    } catch (cause) {
      setResourceActionError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const openResourceAction = (resource: PluginResourceDescriptor, item: PluginResourceView, action: PluginResourceAction) => {
    setResourceAction({ resource, item });
    setResourceActionResult(null);
    setResourceActionError(null);
    void executeResourceAction({ resource, item }, action);
  };

  return <div className={styles.panel}>
    {plugin.resources.map((resource) => <ResourceList
      key={resource.type}
      resource={resource}
      busy={busy !== null}
      onAction={(item, action) => openResourceAction(resource, item, action)}
      onRefresh={(item) => void run(`refresh:${item.id}`, async () => {
        await api.refreshPluginResource(plugin.id, resource.type, item.id);
      })}
      onDelete={(item) => run(`delete:${item.id}`, async () => {
        await api.deletePluginResource(plugin.id, resource.type, item.id);
      })}
    />)}
    {error && <span className={styles.error} role="alert">{error}</span>}
    {resourceAction && <ResourceActionModal
      action={resourceAction.resource.actions.find((item) => item.target === "resource") ?? null}
      cardAction={resourceAction.resource.actions.find((item) => item.target === "card") ?? null}
      result={resourceActionResult}
      busy={busy !== null}
      error={resourceActionError}
      onClose={() => setResourceAction(null)}
      onCardAction={(action, card) => void executeResourceAction(resourceAction, action, { cardId: card.id })}
    />}
  </div>;
}

function ResourceList({ resource, busy, onAction, onRefresh, onDelete }: {
  resource: PluginResourceDescriptor;
  busy: boolean;
  onAction: (item: PluginResourceView, action: PluginResourceAction) => void;
  onRefresh: (item: PluginResourceView) => void;
  onDelete: (item: PluginResourceView) => Promise<boolean>;
}) {
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("all");
  const filtered = useMemo(
    () => resource.resources.filter((item) => item.displayName.toLowerCase().includes(query.trim().toLowerCase()) && (filter === "all" || item.state.status === filter)),
    [resource.resources, query, filter],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * PAGE_SIZE, Math.min(page, pageCount) * PAGE_SIZE);

  useEffect(() => setPage(1), [query, filter]);

  return <FormField label={pluginText(resource.displayName, locale)}>
    <div className={styles.resourceSection}>
      {resource.resources.length > 0 && <div className={styles.toolbar}>
        <TextInput aria-label={t("搜索账号")} placeholder={t("搜索账号")} value={query} onChange={(event) => setQuery(event.target.value)} />
        <Select ariaLabel={t("账号状态")} value={filter} onChange={setFilter} options={[
          { value: "all", label: t("全部状态") },
          { value: "ready", label: t("可用") },
          { value: "cooling", label: t("冷却中") },
          { value: "invalid", label: t("已失效") },
        ]} />
      </div>}
      <div className={styles.resourceList}>
        {visible.map((item) => <ResourceRow
          key={item.id}
          item={item}
          actions={resource.actions.filter((action) => action.target === "resource")}
          canRefresh={resource.canRefresh}
          disabled={busy}
          onAction={(action) => onAction(item, action)}
          onRefresh={() => onRefresh(item)}
          onDelete={() => onDelete(item)}
        />)}
        {visible.length === 0 && <span className={styles.empty}>{resource.resources.length ? t("没有匹配的账号") : t("还没有账号，请先添加。")}</span>}
      </div>
      {pageCount > 1 && <div className={styles.pagination}>
        <Button size="small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>{t("上一页")}</Button>
        <span>{t("第 {page} / {total} 页", { page: Math.min(page, pageCount), total: pageCount })}</span>
        <Button size="small" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>{t("下一页")}</Button>
      </div>}
    </div>
  </FormField>;
}

function ResourceRow({ item, actions, canRefresh, disabled, onAction, onRefresh, onDelete }: {
  item: PluginResourceView;
  actions: PluginResourceAction[];
  canRefresh: boolean;
  disabled: boolean;
  onAction: (action: PluginResourceAction) => void;
  onRefresh: () => void;
  onDelete: () => Promise<boolean>;
}) {
  const { locale } = useI18n();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const moreItems = [
    ...actions.map((action) => ({ id: action.id, label: pluginText(action.displayName, locale), onSelect: () => onAction(action) })),
    { id: "remove-resource", label: t("移除账号"), onSelect: () => setConfirmRemove(true) },
  ];
  return <Card className={styles.resourceRow}>
    <div>
      <div className={styles.resourceIdentity}><strong title={item.displayName}>{item.displayName}</strong><StateBadge state={item.state} /></div>
      {item.selected && <small>{t("当前账号")}</small>}
      {item.description && <span>{pluginText(item.description, locale)}</span>}
      {item.metrics.map((metric) => <span key={metric.id}>
        {metric.unit === "percent"
          ? t("{label} 剩余 {percent}%", { label: pluginText(metric.label, locale), percent: Math.round(metric.value) })
          : `${pluginText(metric.label, locale)}: ${metric.value}`}
      </span>)}
      {item.links?.map(link => <Button key={link.url} size="small" onClick={() => void api.openExternalUrl(link.url)}>{pluginText(link.label, locale)}</Button>)}
    </div>
    <div className={styles.actions}>
      {confirmRemove ? <>
        <span className={styles.error}>{t("确认移除账号？")}</span>
        <Button size="small" disabled={disabled} onClick={() => setConfirmRemove(false)}>{t("取消")}</Button>
        <Button size="small" disabled={disabled} onClick={() => void onDelete().then((removed) => { if (removed) setConfirmRemove(false); })}>{t("确认移除")}</Button>
      </> : <>
        {canRefresh && <Button size="small" disabled={disabled} onClick={onRefresh}>{t("刷新账号")}</Button>}
        {moreItems.length > 0 && <ActionMenu label={t("更多")} disabled={disabled} items={moreItems} />}
      </>}
    </div>
  </Card>;
}

function ResourceActionModal({ action, cardAction, result, busy, error, onClose, onCardAction }: {
  action: PluginResourceAction | null;
  cardAction: PluginResourceAction | null;
  result: PluginResourceActionResult | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onCardAction: (action: PluginResourceAction, card: PluginResourceActionCard) => void;
}) {
  const { locale } = useI18n();
  const [pendingCard, setPendingCard] = useState<PluginResourceActionCard | null>(null);
  const title = result ? pluginText(result.title, locale) : action ? pluginText(action.displayName, locale) : t("资源详情");
  const cardActions = cardAction ? [cardAction] : [];

  return <>
    <Modal compact open title={title} busy={busy} onClose={onClose} closeLabel={t("关闭")}>
      <div className={styles.actionBody}>
        {result?.description && <span className={styles.actionDescription}>{pluginText(result.description, locale)}</span>}
        {busy && <span className={styles.empty}>{t("正在加载…")}</span>}
        {error && <span className={styles.error} role="alert">{error}</span>}
        {!busy && !error && result && !result.description && result.cards.length === 0 && <span className={styles.empty}>{t("没有可用的重置卡。")}</span>}
        {!busy && !error && result && <div className={styles.actionCardList}>
        {result.cards.map((card) => <Card key={card.id} className={styles.actionCard}>
          <div className={styles.actionCardMain}>
            <strong>{pluginText(card.title, locale)}</strong>
            {card.status && <span>{formatActionStatus(card.status, locale)}</span>}
            {card.grantedAtMs !== null && card.grantedAtMs !== undefined && <span>{t("发放时间：{time}", { time: formatActionDate(card.grantedAtMs, locale) })}</span>}
            {card.expiresAtMs !== null && card.expiresAtMs !== undefined && <span>{t("到期时间：{time}", { time: formatActionDate(card.expiresAtMs, locale) })}</span>}
            {card.fields.map((field) => <span key={field.id}>{pluginText(field.label, locale)}: {field.value}</span>)}
          </div>
          {cardActions.length > 0 && <div className={styles.actions}>
            {cardActions.map((cardActionItem) => <Button
              key={cardActionItem.id}
              size="small"
              disabled={busy || card.status !== "available"}
              onClick={() => cardActionItem.destructive ? setPendingCard(card) : onCardAction(cardActionItem, card)}
            >{pluginText(cardActionItem.displayName, locale)}</Button>)}
          </div>}
        </Card>)}
      </div>}
      </div>
    </Modal>
    {pendingCard && cardAction && <ConfirmDialog
      open
      title={t("使用重置卡")}
      busy={busy}
      confirmLabel={t("确认使用")}
      onCancel={() => setPendingCard(null)}
      onConfirm={() => {
        const card = pendingCard;
        setPendingCard(null);
        onCardAction(cardAction, card);
      }}
    >
      <p>{t("使用后会立即消耗这张重置卡，且无法恢复。确定继续吗？")}</p>
      <strong>{pluginText(pendingCard.title, locale)}</strong>
    </ConfirmDialog>}
  </>;
}

function formatActionStatus(status: PluginResourceActionCard["status"], locale: string) {
  const value = typeof status === "string" ? status : pluginText(status, locale);
  switch (value.toLowerCase()) {
    case "available": return t("可用");
    case "redeemed":
    case "used": return t("已使用");
    case "expired": return t("已过期");
    default: return value;
  }
}

function formatActionDate(value: number, locale: string) {
  return new Date(value).toLocaleString(locale);
}

function StateBadge({ state }: { state: PluginResourceView["state"] }) {
  if (state.status === "cooling") {
    return <span className={styles.cooling} title={state.message ?? undefined}>{t("冷却中")}</span>;
  }
  if (state.status === "invalid") {
    return <span className={styles.invalid} title={state.message ?? undefined}>{t("已失效")}</span>;
  }
  return <span className={styles.ready}>{t("可用")}</span>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
