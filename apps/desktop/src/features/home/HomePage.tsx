import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { OverviewActivity } from "./overview/OverviewActivity";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { HomeMetrics } from "./metrics/HomeMetrics";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { OverviewTimeRangeFilter, type OverviewRangePreset, type QuickPreset } from "./overview/OverviewTimeRangeFilter";
import { PageActions } from "../../shell/PageActions";
import { Button } from "../../shared/ui/Button";
import { Card } from "../../shared/ui/Card";
import { useCursorStore } from "../cursor/state";
import { useModelsStore } from "../models/state";
import { usePluginsStore } from "../plugins/state";
import { useOverview } from "./useOverview";
import { configuredModelOptions } from "../../shared/utils/configuredModelOptions";
import { formatTimeInput, parseTimeInput } from "../../shared/utils/parseTimeInput";
import { useI18n } from "../../i18n/store";
import styles from "./HomePage.module.scss";

type TimeRange = { startMs: number; endMs: number };

const ONBOARDING_DISMISSED_KEY = "byok.onboarding.dismissed";

function readOnboardingDismissed(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function presetRange(preset: Exclude<OverviewRangePreset, "custom">, now = new Date()): TimeRange {
  const endMs = now.getTime();
  if (preset === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs };
  }
  if (preset === "month") {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 1);
    return { startMs: start.getTime(), endMs };
  }
  const duration = preset === "ten-minutes" ? 10 * 60_000
    : preset === "hour" ? 60 * 60_000
    : 7 * 24 * 60 * 60_000;
  return { startMs: now.getTime() - duration, endMs };
}

export function HomePage() {
  const navigate = useNavigate();
  const { models } = useModelsStore();
  const { plugins } = usePluginsStore();
  const { cursorHarness } = useCursorStore();
  const { locale } = useI18n();
  const [preset, setPreset] = useState<OverviewRangePreset>("month");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);
  const selectedRange = useMemo(() => preset === "custom" ? customRange : presetRange(preset), [preset, customRange, refreshVersion]);

  const { overview: filteredOverview, busy: rangeBusy } = useOverview(selectedRange, appliedModels, refreshVersion);
  const dailyTokenUsage = filteredOverview.token_usage_series.map((bucket) => ({
    bucketStartMs: bucket.bucket_start_ms,
    inputTokens: bucket.input_tokens,
    cacheReadTokens: bucket.cache_read_tokens,
    cacheWriteTokens: bucket.cache_write_tokens,
    outputTokens: bucket.output_tokens,
  }));
  const metrics = {
    llmCalls: filteredOverview.metrics.llm_calls,
    successfulCalls: filteredOverview.metrics.successful_calls,
    failedCalls: filteredOverview.metrics.failed_calls,
    tokenUsage: filteredOverview.metrics.token_usage,
    promptTokens: filteredOverview.metrics.prompt_tokens,
    cacheReadTokens: filteredOverview.metrics.cache_read_tokens,
    cacheWriteTokens: filteredOverview.metrics.cache_write_tokens,
  };
  const openCustom = (open: boolean) => {
    if (open) {
      const activeRange = selectedRange ?? presetRange("hour");
      setCustomStart(formatTimeInput(new Date(activeRange.startMs)));
      setCustomEnd(formatTimeInput(new Date(activeRange.endMs)));
    }
    setCustomOpen(open);
  };
  const applyCustom = () => {
    const startMs = parseTimeInput(customStart);
    const endMs = parseTimeInput(customEnd);
    if (startMs === null || endMs === null || startMs >= endMs) return;
    setCustomRange({ startMs, endMs });
    setQuick(null);
    setPreset("custom");
    setCustomOpen(false);
  };
  const selectQuick = (durationMs: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - durationMs);
    setCustomStart(formatTimeInput(start));
    setCustomEnd(formatTimeInput(end));
    setCustomRange({ startMs: start.getTime(), endMs: end.getTime() });
    setQuick(durationMs === 4 * 60 * 60_000 ? "four-hours" : "twenty-four-hours");
    setPreset("custom");
    setCustomOpen(false);
  };
  const selectPreset = (value: Exclude<OverviewRangePreset, "custom">) => {
    setPreset(value);
    setQuick(null);
    setCustomOpen(false);
  };
  const refresh = async () => {
    setRefreshVersion((version) => version + 1);
  };
  const dismissOnboarding = () => {
    setOnboardingDismissed(true);
    try {
      window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  };
  const modelOptions = configuredModelOptions(models, plugins, locale);
  const hasModels = modelOptions.length > 0;
  const takeoverActive = cursorHarness?.integration === "enabled";
  const hasCalls = metrics.llmCalls > 0;
  const showOnboarding = !onboardingDismissed && (!hasModels || (!takeoverActive && !hasCalls));

  const sections: VirtualPageSection[] = [
    ...(showOnboarding ? [{
      key: "onboarding",
      estimatedHeight: 132,
      content: <Card className={styles.onboarding}>
        <div className={styles.onboardingHeader}>
          <strong>{t("快速开始")}</strong>
          {hasModels && <button type="button" className={styles.dismissButton} onClick={dismissOnboarding}>{t("不再提示")}</button>}
        </div>
        <div className={styles.steps}>
          <div className={styles.step} data-done={hasModels}>
            <div className={styles.stepTop}>
              <span className={styles.stepTitle}>{t("1. 配置模型来源")}</span>
              <span className={styles.stepStatus} data-done={hasModels}>{hasModels ? t("已完成") : t("待完成")}</span>
            </div>
            <div className={styles.stepActions}>
              <Button size="small" variant={hasModels ? "secondary" : "primary"} onClick={() => navigate("/models")}>{t("模型管理")}</Button>
              <Button size="small" variant="ghost" onClick={() => navigate("/providers")}>{t("连接账号")}</Button>
            </div>
          </div>
          <div className={styles.step} data-done={hasCalls}>
            <div className={styles.stepTop}>
              <span className={styles.stepTitle}>{t("2. 验证模型连通")}</span>
              <span className={styles.stepStatus} data-done={hasCalls}>{hasCalls ? t("已验证") : t("建议验证")}</span>
            </div>
            <div className={styles.stepActions}>
              <Button size="small" onClick={() => navigate("/models")}>{t("测试模型")}</Button>
            </div>
          </div>
          <div className={styles.step} data-done={takeoverActive}>
            <div className={styles.stepTop}>
              <span className={styles.stepTitle}>{t("3. 开启左侧 Cursor 接管")}</span>
              <span className={styles.stepStatus} data-done={takeoverActive}>{takeoverActive ? t("已开启") : t("未开启")}</span>
            </div>
          </div>
        </div>
      </Card>,
    }] : []),
    {
      key: "metrics",
      estimatedHeight: 80,
      content: <HomeMetrics data={metrics} />,
    },
    {
      key: "daily-token-usage",
      estimatedHeight: 190,
      content: <DailyTokenUsageChart
        data={dailyTokenUsage}
        granularity={filteredOverview.token_usage_granularity}
      />,
    },
    {
      key: "activity",
      estimatedHeight: 160,
      content: <OverviewActivity endMs={selectedRange?.endMs ?? Date.now()} modelHashes={appliedModels} refreshVersion={refreshVersion} />,
    },
  ];

  return <>
    <PageActions><OverviewTimeRangeFilter
      value={preset}
      quick={quick}
      customOpen={customOpen}
      customStart={customStart}
      customEnd={customEnd}
      modelOptions={modelOptions}
      selectedModels={appliedModels}
      busy={rangeBusy}
      onSelect={selectPreset}
      onQuickSelect={selectQuick}
      onCustomOpenChange={openCustom}
      onCustomStartChange={setCustomStart}
      onCustomEndChange={setCustomEnd}
      onSelectedModelsChange={setAppliedModels}
      onCustomApply={applyCustom}
      onRefresh={() => void refresh()}
    /></PageActions>
    <PageContent title={t("运行概览")} sections={sections} />
  </>;
}
