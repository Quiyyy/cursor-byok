import { useState } from "react";
import { FormField, TextInput } from "../../shared/ui/FormControls";
import { Select } from "../../shared/ui/Select";
import styles from "./ContextWindowField.module.scss";

const PRESETS = [128000, 200000, 256000, 500000, 1000000];
export const validContextWindow = (value: number | null) => value === null || (Number.isSafeInteger(value) && value > 0);

export function ContextWindowField({ value, onChange, disabled }: {
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(value !== null && !PRESETS.includes(value));
  const isCustom = custom || (value !== null && !PRESETS.includes(value));
  return <FormField label={t("上下文窗口")} hint={t("保存后从下一轮对话生效，请选择服务商支持的容量。")}>
    <div className={styles.field}>
      <Select ariaLabel={t("上下文窗口")} disabled={disabled} value={isCustom ? "custom" : String(value ?? "")} options={[
        { value: "", label: t("跟随模型默认") },
        ...PRESETS.map((tokens) => ({ value: String(tokens), label: tokens >= 1000000 ? `${tokens / 1000000}m` : `${tokens / 1000}k` })),
        { value: "custom", label: t("自定义") },
      ]} onChange={(next) => {
        setCustom(next === "custom");
        if (next !== "custom") onChange(next ? Number(next) : null);
      }} />
      {isCustom && <TextInput type="number" aria-label={t("上下文 Token 数")} disabled={disabled} min={1} step={1} max={Number.MAX_SAFE_INTEGER} placeholder="200000" value={value ?? ""} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)} />}
    </div>
  </FormField>;
}
