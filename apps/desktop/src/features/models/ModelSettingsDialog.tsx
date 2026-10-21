import { useEffect, useState } from "react";
import { api } from "../../shared/api";
import { appStore } from "../../shared/store/appStore";
import { Modal } from "../../shared/ui/Modal";
import { ContextWindowField, validContextWindow } from "./ContextWindowField";

export function ModelSettingsDialog({ model, onClose }: {
  model: { id: string; name: string };
  onClose: () => void;
}) {
  const [value, setValue] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.modelSettings(model.id).then((settings) => {
      if (active) { setValue(settings.context_window_tokens); setLoading(false); }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [model.id]);
  const save = async () => {
    setSaving(true); setError("");
    try {
      await api.setModelSettings(model.id, { context_window_tokens: value });
      await appStore.refresh();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };
  return <Modal open title={t("模型设置 · {model}", { model: model.name })} busy={saving} submitDisabled={loading || !validContextWindow(value)} submitLabel={t("保存")} closeLabel={t("取消")} onSubmit={() => void save()} onClose={onClose} banner={error ? <span role="alert">{error}</span> : undefined}>
    {loading ? <span>{error ? t("加载失败") : t("加载中…")}</span> : <ContextWindowField value={value} onChange={setValue} disabled={saving} />}
  </Modal>;
}
