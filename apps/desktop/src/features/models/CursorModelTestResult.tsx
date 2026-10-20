import type { ModelConnectivityResult } from "../../shared/api";
import { Icon } from "../../shared/ui/Icon";
import { TooltipTrigger } from "../../shared/ui/TooltipTrigger";
import { informationOutlineIcon } from "../../shared/ui/icons";
import styles from "./CursorModelTestResult.module.scss";
import { useI18n } from "../../i18n/store";

export type CursorModelTestState = (
  | { status: "success"; result: ModelConnectivityResult }
  | { status: "error"; error: string }
  | { status: "cancelled" }
) & { completedAt: number };

export function CursorModelTestResult({ state, testing = false, compact = false }: {
  state?: CursorModelTestState;
  testing?: boolean;
  /** List rows keep unknown, running, cancelled and completed states explicit. */
  compact?: boolean;
}) {
  const { locale } = useI18n();
  const completedAt = state ? new Date(state.completedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  if (testing) {
    return compact
      ? <span className={`${styles.compact} ${styles.testing}`}>{t("测试中…")}</span>
      : <div className={`${styles.root} ${styles.testing}`}><span className={styles.summary}>{t("测试中…")}</span></div>;
  }
  if (!state) {
    return compact
      ? <span className={`${styles.compact} ${styles.idle}`}>{t("未测试")}</span>
      : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{t("未测试")}</span></div>;
  }
  if (state.status === "cancelled") {
    return compact
      ? <span className={`${styles.compact} ${styles.idle}`}>{t("测试已取消")}</span>
      : <div className={`${styles.root} ${styles.idle}`}><span className={styles.summary}>{t("测试已取消")}</span></div>;
  }

  const success = state.status === "success";
  const summary = success
    ? t("速度：{speed} tokens/s", { speed: formatSpeed(state.result.tokens_per_second) })
    : t("错误：{error}", { error: state.error });
  const detail = success
    ? t("速度 {speed} tokens/s · 首字 {firstText} ms · 总耗时 {duration} ms · 输出 {tokens} tokens{estimated} · 返回：{output}", {
      speed: formatSpeed(state.result.tokens_per_second),
      firstText: state.result.first_valid_response_ms ?? "--",
      duration: state.result.duration_ms,
      tokens: state.result.output_tokens,
      estimated: state.result.tokens_estimated ? t("（估算）") : "",
      output: state.result.output || "--",
    })
    : t("测试失败：{error}", { error: state.error });

  if (compact) {
    return <div className={styles.testSummary}>
      <TooltipTrigger label={detail}>
        <button type="button" className={`${styles.compact} ${success ? styles.success : styles.error}`}>
          {success ? t("通过 · {speed} tokens/s", { speed: formatSpeed(state.result.tokens_per_second) }) : t("测试失败")}
          <Icon icon={informationOutlineIcon} size="1em" />
        </button>
      </TooltipTrigger>
      <time className={styles.testTime} dateTime={new Date(state.completedAt).toISOString()}>{t("测试于 {time}", { time: completedAt })}</time>
    </div>;
  }

  return <div className={`${styles.root} ${success ? styles.success : styles.error}`}>
    <span className={styles.summary}>{summary}</span>
    <TooltipTrigger label={detail}><button type="button" className={styles.details}>{t("查看详情")}<Icon icon={informationOutlineIcon} size="1.1em" /></button></TooltipTrigger>
  </div>;
}

function formatSpeed(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}
