import { useState } from "react";
import { Button } from "../../shared/ui/Button";
import { TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import styles from "./InlineContextWindow.module.scss";

const PRESETS = [128000, 200000, 256000, 500000, 1000000];
const format = (n: number) => n >= 1000000 ? `${n / 1000000}m` : `${n / 1000}k`;

export function InlineContextWindow({ value, defaultTokens = 200000, disabled, onChange }: {
  value: number | null;
  defaultTokens?: number;
  disabled: boolean;
  onChange: (value: number | null) => Promise<boolean>;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const parsed = Number(draft);
  const valid = Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647;
  const saveCustom = async () => { if (valid && await onChange(parsed)) setCustom(false); };
  return <div className={styles.root}>
    <span className={styles.label}>{t("上下文")}</span>
    {custom ? <div className={styles.custom}>
      <TextInput aria-label={t("上下文 Token 数")} type="number" min={1} max={2147483647} step={1} value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); void saveCustom(); }
        if (e.key === "Escape") setCustom(false);
      }} />
      <Button size="small" disabled={disabled || !valid} onClick={() => void saveCustom()}>{t("保存")}</Button>
      <Button variant="ghost" size="small" disabled={disabled} onClick={() => setCustom(false)}>{t("取消")}</Button>
    </div> : <Select ariaLabel={t("上下文窗口")} value={String(value ?? "")} disabled={disabled} options={[
      { value: "", label: t("默认 {size}", { size: format(defaultTokens) }) },
      ...PRESETS.map((n) => ({ value: String(n), label: format(n) })),
      ...(value !== null && !PRESETS.includes(value) ? [{ value: String(value), label: format(value) }] : []),
      { value: "custom", label: t("自定义") },
    ]} onChange={(next) => {
      if (next === "custom") { setDraft(String(value ?? defaultTokens)); setCustom(true); }
      else void onChange(next ? Number(next) : null);
    }} />}
  </div>;
}
