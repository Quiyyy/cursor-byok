import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/store";
import { api, type CursorModelSettings } from "../../shared/api";
import { useAppStore } from "../../shared/store/appStore";
import { Button } from "../../shared/ui/Button";
import { ModelSelect } from "../../shared/ui/ModelSelect";
import { TitledCard } from "../../shared/ui/TitledCard";
import { useMessage } from "../../shared/ui/message";
import { configuredModelOptions } from "../../shared/utils/configuredModelOptions";
import styles from "./CursorModelSettingsCard.module.scss";

export function CursorModelSettingsCard() {
  const { models, plugins } = useAppStore();
  const { locale } = useI18n();
  const message = useMessage();
  const [settings, setSettings] = useState<CursorModelSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const options = useMemo(() => configuredModelOptions(models, plugins, locale), [models, plugins, locale]);
  const selected = options.find((option) => option.value === settings?.model_id);

  useEffect(() => {
    let active = true;
    void api.cursorModelSettings().then((value) => { if (active) setSettings(value); })
      .catch((cause: unknown) => { if (active) message(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [message]);

  const save = async () => {
    setSaving(true);
    try {
      setSettings(await api.setCursorDefaultModel(draft));
      setEditing(false);
      message(t("默认模型已保存，重载 Cursor 窗口后生效"));
    } catch (cause) {
      message(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  return <TitledCard title={t("Cursor 默认模型")} action={editing ? <div className={styles.actions}>
    <Button size="small" disabled={saving} onClick={() => { setDraft(settings?.model_id ?? ""); setEditing(false); }}>{t("取消")}</Button>
    <Button variant="primary" size="small" disabled={saving || !options.some((option) => option.value === draft)} onClick={() => void save()}>{saving ? t("保存中…") : t("保存")}</Button>
  </div> : <button type="button" className={styles.edit} disabled={!settings || options.length === 0} onClick={() => { setDraft(settings?.model_id ?? ""); setEditing(true); }}>{t("编辑")}</button>}>
    <div className={styles.row}>
      <div className={styles.description}>
        <strong>{t("默认模型")}</strong>
        <small>{t("保存后重载 Cursor 窗口。新对话沿用所选模型，不自动切回 Auto；已有对话保留各自选择。")}</small>
      </div>
      {editing ? <div className={styles.select}><ModelSelect mode="single" label={t("默认模型")} value={draft} options={options} disabled={saving} onChange={setDraft} /></div>
        : <span className={styles.value}>{!settings ? t("加载中…") : selected?.label ?? (settings.model_id ? t("模型不可用，请重新选择") : t("尚未设置"))}</span>}
    </div>
  </TitledCard>;
}
