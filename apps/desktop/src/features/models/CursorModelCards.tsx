import type { IconifyIcon } from "@iconify/react/offline";
import { useEffect, useRef, useState, type ReactNode } from "react";
import Sortable from "sortablejs";
import type { Model, ModelSettings, PluginModelDescriptor } from "../../shared/api";
import { InlineContextWindow } from "./InlineContextWindow";
import { Card } from "../../shared/ui/Card";
import { Icon } from "../../shared/ui/Icon";
import { chevronDownIcon, chevronRightIcon, claudeIcon, dragIcon, editIcon, openAiIcon } from "../../shared/ui/icons";
import { sourceIcon } from "../../shared/ui/workbenchIcons";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { Button } from "../../shared/ui/Button";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import styles from "./CursorSettings.module.scss";

export type CursorModelGrouping = "flat" | "provider" | "type";

export type CursorModelGroup = {
  key: string;
  label: string;
  icon: IconifyIcon;
  models: Model[];
};

type CursorModelCardsProps = {
  models: Model[];
  pluginModels: PluginModelDescriptor[];
  grouping: CursorModelGrouping;
  disabled: boolean;
  testingModelHashes: Set<string>;
  testResults: Map<string, CursorModelTestState>;
  onTest: (model: Model) => void;
  onEdit: (model: Model) => void;
  modelSettings: Record<string, ModelSettings>;
  savingModelSettings: ReadonlySet<string>;
  onContextChange: (id: string, value: number | null) => Promise<boolean>;
  onDuplicate: (model: Model) => void;
  onDelete: (model: Model) => void;
  onTestPluginModel: (model: PluginModelDescriptor) => void;
  onPluginSettings: (model: PluginModelDescriptor) => void;
  onReorder: (modelHashes: string[]) => void;
  onGroupSettings: (group: CursorModelGroup) => void;
};

type ModelGridProps = Omit<CursorModelCardsProps, "grouping" | "pluginModels" | "onTestPluginModel" | "onPluginSettings"> & {
  sortable: boolean;
};

export function cursorModelGroups(models: Model[], grouping: Exclude<CursorModelGrouping, "flat">): CursorModelGroup[] {
  const groups = new Map<string, CursorModelGroup>();
  for (const model of models) {
    const descriptor = grouping === "provider" ? providerGroup(model) : typeGroup(model);
    const group = groups.get(descriptor.key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(descriptor.key, { ...descriptor, models: [model] });
    }
  }
  return [...groups.values()];
}

export function CursorModelCards(props: CursorModelCardsProps) {
  const builtins = props.models.length === 0 ? null : props.grouping === "flat"
    ? <ModelGrid {...props} sortable />
    : <>
      {cursorModelGroups(props.models, props.grouping).map((group) => <CollapsibleGroup
        key={group.key}
        label={group.label}
        icon={group.icon}
        count={group.models.length}
        settingsDisabled={props.disabled || props.testingModelHashes.size > 0}
        onSettings={props.grouping === "provider" ? () => props.onGroupSettings(group) : undefined}
      >
        {group.models.map((model) => <ModelListRow
          key={model.model_hash}
          model={model}
          disabled={props.disabled}
          testing={props.testingModelHashes.has(model.model_hash)}
          result={props.testResults.get(model.model_hash)}
          onTest={() => props.onTest(model)}
          onEdit={() => props.onEdit(model)}
          contextControl={contextControl(props, model.model_hash)}
          onDuplicate={() => props.onDuplicate(model)}
          onDelete={() => props.onDelete(model)}
        />)}
      </CollapsibleGroup>)}
    </>;
  return <div className={props.grouping === "flat" ? styles.modelGroups : styles.modelCollection}>
    {builtins}
    {pluginGroups(props.pluginModels).map((group) => <CollapsibleGroup
      key={`${group.pluginId}:${group.providerId}`}
      label={group.pluginName}
      iconSrc={group.icon}
      count={group.models.length}
      onSettings={() => props.onPluginSettings(group.models[0])}
      settingsLabel={t("管理模型")}
    >
      {group.models.map((model) => <PluginModelRow
        key={model.id}
        model={model}
        disabled={props.disabled}
        testing={props.testingModelHashes.has(model.id)}
        result={props.testResults.get(model.id)}
        onTest={() => props.onTestPluginModel(model)}
        contextControl={contextControl(props, model.id, model.contextWindowTokens ?? 200000)}
      />)}
    </CollapsibleGroup>)}
  </div>;
}

function pluginGroups(models: PluginModelDescriptor[]) {
  const groups: { pluginId: string; providerId: string; pluginName: string; icon: string; models: PluginModelDescriptor[] }[] = [];
  for (const model of models) {
    let group = groups.find((candidate) => candidate.pluginId === model.pluginId && candidate.providerId === model.providerId);
    if (!group) {
      group = { pluginId: model.pluginId, providerId: model.providerId, pluginName: model.pluginName, icon: model.icon, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

function CollapsibleGroup({ label, icon, iconSrc, count, defaultOpen = true, onSettings, settingsLabel, settingsDisabled, children }: {
  label: string;
  icon?: IconifyIcon;
  iconSrc?: string;
  count: number;
  defaultOpen?: boolean;
  onSettings?: () => void;
  settingsLabel?: string;
  settingsDisabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className={styles.groupCard}>
    <div className={styles.groupHeader}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon icon={open ? chevronDownIcon : chevronRightIcon} size="1em" />
        {icon && <Icon icon={icon} size="1.1em" />}
        {iconSrc && <Icon src={iconSrc} size="1.1em" />}
        <span className={styles.groupLabel}>{label}</span>
        <span className={styles.groupCount} aria-label={t("{count} 个模型", { count })}>{count}</span>
      </button>
      {onSettings && <button type="button" className={styles.groupSettings} disabled={settingsDisabled} onClick={onSettings}>
        {settingsLabel ?? t("分组设置")}
      </button>}
    </div>
    {open && <div className={styles.modelList}>{children}</div>}
  </section>;
}

function ModelListRow({ model, disabled, testing, result, onTest, onEdit, contextControl, onDuplicate, onDelete }: {
  model: Model;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  onEdit: () => void;
  contextControl: ReactNode;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return <div className={styles.modelRow}>
    <div className={styles.modelRowName}>
      <button className={styles.modelNameButton} title={model.display_name} disabled={disabled || testing} onClick={onEdit}>{model.display_name}</button>
      <span className={styles.modelRowModelId} title={model.model_id}>{model.model_id}</span>
    </div>
    {contextControl}
    <CursorModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelCardActions}>
      <Button variant="ghost" size="small" disabled={disabled && !testing} onClick={onTest}>{testing ? t("取消测试") : t("测试")}</Button>
      <TooltipTrigger label={t("编辑连接")}><Button variant="ghost" size="small" className={styles.editAction} aria-label={t("编辑连接")} disabled={disabled || testing} onClick={onEdit}><Icon icon={editIcon} size="1.1em" /></Button></TooltipTrigger>
      <ActionMenu iconOnly label={t("更多")} disabled={disabled || testing} items={[
        { id: "duplicate", label: t("复制为新模型"), onSelect: onDuplicate },
        { id: "delete", label: t("删除"), onSelect: onDelete },
      ]} />
    </div>
  </div>;
}

function PluginModelRow({ model, disabled, testing, result, onTest, contextControl }: {
  model: PluginModelDescriptor;
  disabled: boolean;
  testing: boolean;
  result: CursorModelTestState | undefined;
  onTest: () => void;
  contextControl: ReactNode;
}) {
  return <div className={styles.modelRow}>
    <div className={styles.modelRowName}>
      <span className={styles.modelRowNameText} title={model.displayName}>{model.displayName}</span>
      <span className={styles.modelRowModelId} title={model.modelId}>{model.modelId}</span>
    </div>
    {contextControl}
    <CursorModelTestResult compact state={result} testing={testing} />
    <div className={styles.modelCardActions}>
      <Button variant="ghost" size="small" disabled={disabled && !testing} onClick={onTest}>{testing ? t("取消测试") : t("测试")}</Button>
    </div>
  </div>;
}

function ModelGrid(props: ModelGridProps) {
  const {
  models,
  sortable: sortableEnabled,
  disabled,
  testingModelHashes,
  testResults,
  onTest,
  onEdit,
  onDuplicate,
  onDelete,
  onReorder,
  } = props;
  const grid = useRef<HTMLDivElement>(null);
  const sortable = useRef<Sortable | null>(null);
  const currentModels = useRef(models);
  const reorder = useRef(onReorder);
  currentModels.current = models;
  reorder.current = onReorder;

  useEffect(() => {
    if (!sortableEnabled || !grid.current) return;
    sortable.current = Sortable.create(grid.current, {
      animation: 160,
      dataIdAttr: "data-model-hash",
      draggable: `.${styles.modelCard}`,
      handle: `.${styles.sortHandle}`,
      ghostClass: styles.sortGhost,
      chosenClass: styles.sortChosen,
      dragClass: styles.sortDragging,
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 3,
      onEnd: (event) => {
        const oldIndex = event.oldDraggableIndex ?? event.oldIndex;
        const newIndex = event.newDraggableIndex ?? event.newIndex;
        if (typeof oldIndex !== "number"
          || typeof newIndex !== "number"
          || oldIndex === newIndex) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        const reordered = currentModels.current.slice();
        const [moved] = reordered.splice(oldIndex, 1);
        if (!moved || newIndex < 0 || newIndex > reordered.length) {
          sortable.current?.sort(currentModels.current.map((model) => model.model_hash), false);
          return;
        }
        reordered.splice(newIndex, 0, moved);
        reorder.current(reordered.map((model) => model.model_hash));
      },
    });
    return () => {
      sortable.current?.destroy();
      sortable.current = null;
    };
  }, [sortableEnabled]);

  useEffect(() => {
    sortable.current?.option("disabled", disabled);
    sortable.current?.sort(models.map((model) => model.model_hash), false);
  }, [disabled, models]);

  return <div ref={grid} className={styles.modelGrid}>
    {models.map((model) => {
      const result = testResults.get(model.model_hash);
      const testing = testingModelHashes.has(model.model_hash);
      return <Card className={styles.modelCard} data-model-hash={model.model_hash} key={model.model_hash}>
        {sortableEnabled && <button type="button" className={styles.sortHandle} disabled={disabled} aria-label={t("拖动排序")} title={t("拖动排序")} onClick={(event) => event.stopPropagation()}>
          <Icon icon={dragIcon} size="1.25em" />
        </button>}
        <div className={styles.modelCardContent}>
          <div className={styles.modelCardTop}>
            <div className={styles.modelCardName}>
              <span className={styles.modelCardNameText}>{model.display_name}</span>
              <span className={styles.modelCardModelId}>{model.model_id}</span>
            </div>
            <span className={styles.modelTypeBadge}>
              <Icon icon={model.type === "anthropic" ? claudeIcon : openAiIcon} />
              {model.type === "anthropic" ? "Anthropic" : "OpenAI"}
            </span>
          </div>
          {(result || testing) && <div className={styles.modelCardTest}>
            <CursorModelTestResult state={result} testing={testing} />
          </div>}
          {contextControl(props, model.model_hash)}
          <div className={styles.modelCardActions}>
            <Button size="small" disabled={disabled && !testing} onClick={() => onTest(model)}>{testing ? t("取消测试") : t("测试")}</Button>
            <Button size="small" disabled={disabled || testing} onClick={() => onEdit(model)}>{t("编辑连接")}</Button>
            <ActionMenu iconOnly label={t("更多")} disabled={disabled || testing} items={[
              { id: "duplicate", label: t("复制为新模型"), onSelect: () => onDuplicate(model) },
              { id: "delete", label: t("删除"), onSelect: () => onDelete(model) },
            ]} />
          </div>
        </div>
      </Card>;
    })}
  </div>;
}

function providerGroup(model: Model) {
  const key = providerDomain(model.base_url);
  const label = model.group_name?.trim() || key;
  return { key, label, icon: sourceIcon };
}

function contextControl(props: Pick<CursorModelCardsProps, "modelSettings" | "savingModelSettings" | "onContextChange" | "disabled">, id: string, defaultTokens = 200000) {
  return <InlineContextWindow value={props.modelSettings[id]?.context_window_tokens ?? null} defaultTokens={defaultTokens} disabled={props.disabled || props.savingModelSettings.has(id)} onChange={(value) => props.onContextChange(id, value)} />;
}

function providerDomain(baseUrl: string) {
  const value = baseUrl.trim();
  try {
    return new URL(value).hostname.toLowerCase() || value;
  } catch {
    try {
      return new URL(`https://${value}`).hostname.toLowerCase() || value;
    } catch {
      return value;
    }
  }
}

function typeGroup(model: Model) {
  if (model.type === "anthropic") return { key: "anthropic", label: "Anthropic", icon: claudeIcon };
  if (model.openai_endpoint === "/v1/chat/completions") return { key: "openai-chat", label: "OpenAI Chat", icon: openAiIcon };
  return { key: "openai-responses", label: "OpenAI Responses", icon: openAiIcon };
}
