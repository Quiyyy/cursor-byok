import { useEffect, useState } from "react";
import { api, type Overview } from "../../../shared/api";
import { ContributionCalendarChart } from "../charts/ContributionCalendarChart";
import styles from "./OverviewActivity.module.scss";

const DAY_MS = 86_400_000;

/** Annual activity is fetched separately; a 30-day overview cannot describe a year. */
export function OverviewActivity({ endMs, modelHashes }: { endMs: number; modelHashes: string[] }) {
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastDayMs = Math.floor(Math.max(0, endMs - 1) / DAY_MS) * DAY_MS;
  const startMs = lastDayMs - 364 * DAY_MS;
  useEffect(() => {
    if (!open) return;
    let active = true;
    setOverview(null);
    setError(null);
    void api.overview({ startMs, endMs, modelHashes }).then((next) => { if (active) setOverview(next); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [open, startMs, endMs, modelHashes]);
  const byDay = new Map<string, number>();
  for (const bucket of overview?.token_usage_series ?? []) {
    const date = new Date(bucket.bucket_start_ms).toISOString().slice(0, 10);
    byDay.set(date, (byDay.get(date) ?? 0) + bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens + bucket.output_tokens);
  }
  const data = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(startMs + index * DAY_MS).toISOString().slice(0, 10);
    return { date, tokens: byDay.get(date) ?? 0 };
  });
  return <details className={styles.root} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t("年度活动")}<span>{t("按 UTC 日期展示最近 365 天，沿用模型筛选")}</span></summary>
    {open && <div className={styles.content}>
      {error ? <span role="alert">{error}</span> : overview ? <ContributionCalendarChart data={data} /> : <span>{t("正在加载年度活动…")}</span>}
    </div>}
  </details>;
}
