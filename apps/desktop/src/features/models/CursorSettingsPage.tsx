import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, configuredPluginModels, type Model, type ModelInput } from "../../shared/api";
import { CursorModelCards, cursorModelGroups, type CursorModelGroup, type CursorModelGrouping } from "./CursorModelCards";
import { CursorModelEditor, emptyCursorModelDraft, type CursorModelDraft } from "./CursorModelEditor";
import { CursorModelTestResult, type CursorModelTestState } from "./CursorModelTestResult";
import { Button } from "../../shared/ui/Button";
import { ActionMenu } from "../../shared/ui/ActionMenu";
import styles from "./CursorSettings.module.scss";
import { PageContent } from "../../shell/layout/PageContent";
import { LegacyModelImport } from "./LegacyModelImport";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { FormField, SecretTextInput, TextInput } from "../../shared/ui/FormControls";
import controls from "../../shared/ui/Controls.module.scss";
import { Icon } from "../../shared/ui/Icon";
import { Modal } from "../../shared/ui/Modal";
import { addIcon } from "../../shared/ui/icons";
import { useMessage } from "../../shared/ui/message";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";

export function CursorSettingsPage() {
  const { models, cursorBusy, plugins } = useAppStore();
  const navigate = useNavigate();
  const message = useMessage();
  const [draft, setDraft] = useState<CursorModelDraft | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Model | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const [testingModelHashes, setTestingModelHashes] = useState<Set<string>>(() => new Set());
  const [modelTestResults, setModelTestResults] = useState<Map<string, CursorModelTestState>>(() => new Map());
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const [batchTesting, setBatchTesting] = useState(false);
  const [grouping, setGrouping] = useState<CursorModelGrouping>("provider");
  const [settingsGroup, setSettingsGroup] = useState<CursorModelGroup | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupBaseUrlDraft, setGroupBaseUrlDraft] = useState("");
  const [groupApiKeyDraft, setGroupApiKeyDraft] = useState("");
  const [groupSettingsBusy, setGroupSettingsBusy] = useState(false);
  const activeModelTests = useRef(new Map<string, { testId: string; controller: AbortController; cancelling: boolean }>());
  const submitting = useRef(false);
  const pluginModels = configuredPluginModels(plugins);
  const testTargets = [
    ...models.map((model) => ({ model_hash: model.model_hash, display_name: model.display_name })),
    ...pluginModels.map((model) => ({ model_hash: model.id, display_name: model.displayName })),
  ];
  const providerGroups = cursorModelGroups(models, "provider");
  const typeGroups = cursorModelGroups(models, "type");
  const openNew = () => {
    const next = emptyCursorModelDraft();
    next.model.sort_order = models.length + 1;
    setEditing(null);
    setEditorError(null);
    setModelOptions([]);
    setDraft(next);
  };
  const openEdit = (model: Model) => {
    setEditorError(null);
    setEditing(model);
    setModelOptions([model.model_id]);
    setDraft({
      providerId: `builtin/${model.type}`,
      model: modelInput(model),
      openAIExtraParamsText: JSON.stringify(model.openai_extra_params, null, 2),
      customHeadersText: JSON.stringify(model.custom_headers, null, 2),
      anthropicExtraParamsText: JSON.stringify(model.anthropic_extra_params, null, 2),
    });
  };
  const discover = async (): Promise<boolean> => {
    if (!draft) return false;
    setDiscovering(true);
    try {
      const custom_headers = parseHeaders(draft.customHeadersText);
      const result = await api.discoverModels({
        type: draft.model.type,
        base_url: draft.model.base_url.trim(),
        api_key: draft.model.api_key.trim(),
        custom_headers_enabled: draft.model.custom_headers_enabled,
        custom_headers,
      });
      setModelOptions([...new Set(result.models)]);
      return true;
    } catch (cause) {
      message(errorText(cause));
      return false;
    } finally {
      setDiscovering(false);
    }
  };
  const persist = async (): Promise<Model | null> => {
    if (!draft) return null;
    const input = draftInput(draft);
    if (editing) {
      const saved = await appStore.updateCursorModel(editing.model_hash, input);
      if (saved) setModelTestResults((current) => {
        const next = new Map(current);
        next.delete(editing.model_hash);
        return next;
      });
      return saved;
    }
    return (await appStore.createModels([input]))?.[0] ?? null;
  };
  const save = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setEditorError(null);
    try {
      if (await persist()) {
        setDraft(null);
        setEditing(null);
      } else {
        setEditorError(appStore.getSnapshot().error);
      }
    } catch (cause) {
      setEditorError(errorText(cause));
    } finally {
      submitting.current = false;
    }
  };
  const cancelModelTest = async (modelHash: string) => {
    const active = activeModelTests.current.get(modelHash);
    if (!active || active.cancelling) return;
    active.cancelling = true;
    active.controller.abort();
    try {
      await api.cancelModelTest(modelHash, active.testId);
    } catch (cause) {
      message(t("取消测试失败：{error}", { error: errorText(cause) }), { duration: 5000 });
    }
  };
  const cancelAllModelTests = async () => {
    await Promise.all([...activeModelTests.current.keys()].map((modelHash) => cancelModelTest(modelHash)));
  };
  const testModel = async (model: { model_hash: string; display_name: string }, notify = true): Promise<"success" | "failure" | "cancelled"> => {
    if (activeModelTests.current.has(model.model_hash)) {
      await cancelModelTest(model.model_hash);
      return "cancelled";
    }
    const active = { testId: crypto.randomUUID(), controller: new AbortController(), cancelling: false };
    activeModelTests.current.set(model.model_hash, active);
    setTestingModelHashes((current) => new Set(current).add(model.model_hash));
    try {
      const result = await api.testModel(model.model_hash, active.testId, active.controller.signal);
      if (active.controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "success", result, completedAt: Date.now() }));
      if (notify) message(t("模型 {model} 连通性测试成功（{duration} ms）", { model: model.display_name, duration: result.duration_ms }));
      return "success";
    } catch (cause) {
      if (active.cancelling || active.controller.signal.aborted) {
        setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "cancelled", completedAt: Date.now() }));
        return "cancelled";
      }
      const error = errorText(cause);
      setModelTestResults((current) => new Map(current).set(model.model_hash, { status: "error", error, completedAt: Date.now() }));
      if (notify) message(t("连通性测试失败：{error}", { error }), { duration: 5000 });
      return "failure";
    } finally {
      if (activeModelTests.current.get(model.model_hash) === active) activeModelTests.current.delete(model.model_hash);
      setTestingModelHashes((current) => {
        const next = new Set(current);
        next.delete(model.model_hash);
        return next;
      });
    }
  };
  const saveAndTest = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setEditorError(null);
    setSavingAndTesting(true);
    try {
      const saved = await persist();
      if (!saved) {
        setEditorError(appStore.getSnapshot().error);
        return;
      }
      setEditing(saved);
      setSavingAndTesting(false);
      await testModel(saved);
    } catch (cause) {
      setEditorError(errorText(cause));
    } finally {
      setSavingAndTesting(false);
      submitting.current = false;
    }
  };
  const testAllModels = async () => {
    if (!testTargets.length || batchTesting) return;
    setBatchTesting(true);
    try {
      const results = await Promise.all(testTargets.map((model) => testModel(model, false)));
      const successful = results.filter((result) => result === "success").length;
      const failed = results.filter((result) => result === "failure").length;
      const cancelled = results.filter((result) => result === "cancelled").length;
      message(cancelled > 0
        ? t("连通性测试已取消：成功 {successful}，失败 {failed}", { successful, failed })
        : failed === 0
          ? t("全部 {count} 个模型连通性测试成功", { count: testTargets.length })
          : t("连通性测试完成：成功 {successful}，失败 {failed}", { successful, failed }),
      { duration: failed === 0 && cancelled === 0 ? 2400 : 5000 });
    } finally {
      setBatchTesting(false);
    }
  };
  const duplicateModel = (model: Model) => {
    const names = new Set(models.map((item) => item.display_name));
    const baseName = t("{name} 副本", { name: model.display_name });
    let displayName = baseName;
    let suffix = 2;
    while (names.has(displayName)) {
      displayName = `${baseName} ${suffix}`;
      suffix += 1;
    }
    openEdit(model);
    setEditing(null);
    setDraft((current) => current && ({
      ...current,
      model: { ...current.model, sort_order: models.length + 1, display_name: displayName },
    }));
  };
  const openGroupSettings = (group: CursorModelGroup) => {
    const completeGroup = providerGroups.find((candidate) => candidate.key === group.key) ?? group;
    setGroupNameDraft(completeGroup.models.find((model) => model.group_name?.trim())?.group_name?.trim() ?? "");
    setGroupBaseUrlDraft(sharedValue(completeGroup.models.map((model) => model.base_url)) ?? "");
    setGroupApiKeyDraft(sharedValue(completeGroup.models.map((model) => model.api_key)) ?? "");
    setSettingsGroup(completeGroup);
  };
  const saveGroupSettings = async () => {
    if (!settingsGroup) return;
    const group_name = groupNameDraft.trim() || null;
    const base_url = groupBaseUrlDraft.trim();
    const api_key = groupApiKeyDraft.trim();
    setGroupSettingsBusy(true);
    try {
      for (const model of settingsGroup.models) {
        const input: ModelInput = {
          ...modelInput(model),
          group_name,
          ...(base_url ? { base_url } : {}),
          ...(api_key ? { api_key } : {}),
        };
        if (input.group_name === (model.group_name ?? null)
          && input.base_url === model.base_url
          && input.api_key === model.api_key) continue;
        await api.updateModel(model.model_hash, input);
        setModelTestResults((current) => {
          const next = new Map(current);
          next.delete(model.model_hash);
          return next;
        });
      }
      setSettingsGroup(null);
    } catch (cause) {
      message(errorText(cause));
    } finally {
      await appStore.refresh();
      setGroupSettingsBusy(false);
    }
  };
  const reorderModels = useCallback(async (modelHashes: string[]) => {
    if (!await appStore.reorderCursorModels(modelHashes)) {
      message(appStore.getSnapshot().error || t("排序失败"));
    }
  }, [message]);

  const list = testTargets.length === 0 ? <div className={styles.empty}>
    <strong>{t("还没有添加模型")}</strong>
    <span>{t("添加 API 模型，或连接账号导入模型。")}</span>
    <Button onClick={() => navigate("/providers")}>{t("连接账号")}</Button>
  </div> : <CursorModelCards
    models={models}
    pluginModels={pluginModels}
    grouping={grouping}
    disabled={cursorBusy}
    testingModelHashes={testingModelHashes}
    testResults={modelTestResults}
    onTest={(model) => void testModel(model)}
    onEdit={openEdit}
    onDuplicate={duplicateModel}
    onDelete={setDeleting}
    onTestPluginModel={(model) => void testModel({ model_hash: model.id, display_name: model.displayName })}
    onPluginSettings={(model) => navigate(`/providers?plugin=${encodeURIComponent(model.pluginId)}&tab=models&provider=${encodeURIComponent(model.providerId)}`)}
    onReorder={reorderModels}
    onGroupSettings={openGroupSettings}
  />;

  const editorTestState = editing ? modelTestResults.get(editing.model_hash) : undefined;
  const editorTesting = Boolean(editing && testingModelHashes.has(editing.model_hash));
  const activeGroups = grouping === "provider" ? providerGroups : typeGroups;
  const pluginSectionHeight = pluginModels.length > 0 ? 60 + pluginModels.length * 56 : 0;
  const estimatedModelHeight = grouping === "flat"
    ? Math.max(380, Math.ceil(models.length / 3) * 196 + pluginSectionHeight)
    : Math.max(380, activeGroups.reduce((height, group) => height + 60 + group.models.length * 56, 0) + Math.max(0, activeGroups.length - 1) * 20 + pluginSectionHeight);

  return <>
    <PageActions position="left">
      <Button variant="ghost" disabled={cursorBusy || (!batchTesting && (!testTargets.length || testingModelHashes.size > 0))} onClick={() => void (batchTesting ? cancelAllModelTests() : testAllModels())}>{batchTesting ? t("取消全部测试") : t("测试全部")}</Button>
    </PageActions>
    <PageActions>
      <LegacyModelImport>{({ busy, open }) => <ActionMenu iconOnly label={t("更多")} disabled={busy || cursorBusy} items={[
        { id: "group-provider", label: t("按来源分组"), disabled: grouping === "provider", onSelect: () => setGrouping("provider") },
        { id: "group-type", label: t("按协议分组"), disabled: grouping === "type", onSelect: () => setGrouping("type") },
        { id: "group-flat", label: t("平铺与排序"), disabled: grouping === "flat", onSelect: () => setGrouping("flat") },
        { id: "accounts", label: t("连接账号"), onSelect: () => navigate("/providers") },
        { id: "import", label: t("导入旧版配置"), onSelect: open },
      ]} />}</LegacyModelImport>
      <Button variant="primary" disabled={cursorBusy} onClick={openNew}><Icon icon={addIcon} size="1.1em" />{t("添加模型")}</Button>
    </PageActions>
    <PageContent title={t("模型管理")} sections={[
      { key: "cursor-settings", estimatedHeight: estimatedModelHeight, content: list },
    ]} />
    <Modal fullHeight open={draft !== null} title={editing ? t("编辑模型") : t("添加 API 模型")} banner={editorError ? <span className={styles.error} role="alert">{editorError}</span> : draft && (editorTesting || editorTestState) ? <CursorModelTestResult state={editorTestState} testing={editorTesting} /> : undefined} busy={cursorBusy || savingAndTesting} submitDisabled={editorTesting} onClose={() => { if (editing && editorTesting) void cancelModelTest(editing.model_hash); setDraft(null); setEditing(null); }} onSubmit={() => void save()} submitLabel={t("保存")} secondaryAction={<button type="button" className={controls.secondary} disabled={cursorBusy || savingAndTesting} onClick={() => void (editorTesting && editing ? cancelModelTest(editing.model_hash) : saveAndTest())}>{savingAndTesting ? t("处理中…") : editorTesting ? t("取消测试") : t("保存并测试")}</button>}>
      {draft && <>
        <CursorModelEditor draft={draft} modelOptions={modelOptions} discovering={discovering} onChange={setDraft} onDiscover={discover} />
      </>}
    </Modal>
    <Modal open={settingsGroup !== null} title={t("分组设置")} busy={groupSettingsBusy || cursorBusy} onClose={() => setSettingsGroup(null)} onSubmit={() => void saveGroupSettings()} submitLabel={t("保存")}>
      {settingsGroup && <div className={styles.editor}>
        <FormField label={t("分组名称")} hint={t("应用于该分组下的全部模型，并作为 Cursor 模型选择器中的徽章标签；清空则恢复显示服务器域名。")}>
          <TextInput placeholder={settingsGroup.key} value={groupNameDraft} onChange={(event) => setGroupNameDraft(event.target.value)} />
        </FormField>
        <FormField label={t("服务器地址")} hint={t("修改后应用于该分组下的全部模型；留空保持各模型现有配置不变。")}>
          <TextInput placeholder={t("留空保持不变")} value={groupBaseUrlDraft} onChange={(event) => setGroupBaseUrlDraft(event.target.value)} />
        </FormField>
        <FormField label="API Key" hint={t("修改后应用于该分组下的全部模型；留空保持各模型现有配置不变。")}>
          <SecretTextInput placeholder={t("留空保持不变")} autoComplete="off" value={groupApiKeyDraft} onChange={(event) => setGroupApiKeyDraft(event.target.value)} />
        </FormField>
      </div>}
    </Modal>
    <ConfirmDialog open={deleting !== null} title={t("删除模型")} cancelLabel={t("取消")} confirmLabel={t("删除")} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void appStore.deleteModel(deleting.model_hash); setDeleting(null); }}><p>{t("确定删除这个模型吗？")}</p></ConfirmDialog>
  </>;
}

function modelInput(model: Model): ModelInput {
  const { model_hash: _hash, created_at_ms: _created, updated_at_ms: _updated, ...input } = model;
  return input;
}

/** 组内所有模型取值一致时返回该值,否则返回 null(表单留空表示保持不变)。 */
function sharedValue(values: string[]): string | null {
  const [first, ...rest] = values;
  if (first === undefined) return null;
  return rest.every((value) => value === first) ? first : null;
}

function draftInput(draft: CursorModelDraft): ModelInput {
  const displayName = draft.model.display_name.trim() || draft.model.model_id.trim();
  const model = {
    ...draft.model,
    display_name: displayName,
    base_url: draft.model.base_url.trim(),
    api_key: draft.model.api_key.trim(),
    tooltip_data: draft.model.tooltip_data.trim() || displayName,
    model_id: draft.model.model_id.trim(),
    openai_extra_params: parseObject(draft.openAIExtraParamsText, t("OpenAI 额外参数")),
    custom_headers: parseHeaders(draft.customHeadersText),
    anthropic_extra_params: parseObject(draft.anthropicExtraParamsText, t("Anthropic 额外参数")),
  };
  if (!model.base_url || !model.api_key || !model.model_id) throw new Error(t("请填写服务器地址、API Key 和模型名称"));
  for (const [label, value] of [[t("上下文窗口 Token"), model.context_window_tokens], [t("最大输出 Token"), model.type === "openai" ? model.max_completion_tokens : model.anthropic_max_tokens], [t("思考预算 Token"), model.thinking_budget_tokens]] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(t("{label} 必须是大于 0 的整数", { label }));
  }
  return model;
}

function parseHeaders(text: string): Record<string, string> {
  const parsed = parseObject(text, t("自定义 Headers"));
  if (Object.values(parsed).some((value) => typeof value !== "string")) throw new Error(t("自定义 Headers 的值必须都是字符串"));
  return parsed as Record<string, string>;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text || "{}"); } catch { throw new Error(t("{label} 必须是有效 JSON", { label })); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("{label} 必须是 JSON 对象", { label }));
  return parsed as Record<string, unknown>;
}

function errorText(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
