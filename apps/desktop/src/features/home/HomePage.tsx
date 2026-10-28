import { useMemo, useState } from "react";
import { OverviewActivity } from "./overview/OverviewActivity";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { HomeMetrics } from "./metrics/HomeMetrics";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { OverviewTimeRangeFilter, type OverviewRangePreset, type QuickPreset } from "./overview/OverviewTimeRangeFilter";
import { PageActions } from "../../shell/PageActions";
import {useModelsStore} from "../models/state";
import {usePluginsStore} from "../plugins/state";
import {useOverview} from "./useOverview";
import {configuredModelOptions} from "../../shared/utils/configuredModelOptions";
import { formatTimeInput, parseTimeInput } from "../../shared/utils/parseTimeInput";
import { useI18n } from "../../i18n/store";

type TimeRange = { startMs: number; endMs: number };

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
  const {models} = useModelsStore();
  const {plugins} = usePluginsStore();
  const { locale } = useI18n();
  const [preset, setPreset] = useState<OverviewRangePreset>("month");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selectedRange = useMemo(() => preset === "custom" ? customRange : presetRange(preset), [preset, customRange, refreshVersion]);

  const {overview:filteredOverview,busy:rangeBusy} = useOverview(selectedRange,appliedModels,refreshVersion);
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
    if (open && !customStart && !customEnd) {
      const now = new Date();
      setCustomEnd(formatTimeInput(now));
      setCustomStart(formatTimeInput(new Date(now.getTime() - 60 * 60_000)));
    }
    setCustomOpen(open);
  };
  const applyCustom = () => {
    const startMs = parseTimeInput(customStart);
    const endMs = parseTimeInput(customEnd);
    if (startMs === null || endMs === null || startMs >= endMs) return;
    setCustomRange({ startMs, endMs });
    setAppliedModels(selectedModels);
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
    setAppliedModels(selectedModels);
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
  const modelOptions = configuredModelOptions(models,plugins,locale);
  const sections: VirtualPageSection[] = [
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
      content: <OverviewActivity endMs={selectedRange?.endMs ?? Date.now()} modelHashes={appliedModels} />,
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
      selectedModels={selectedModels}
      busy={rangeBusy}
      onSelect={selectPreset}
      onQuickSelect={selectQuick}
      onCustomOpenChange={openCustom}
      onCustomStartChange={setCustomStart}
      onCustomEndChange={setCustomEnd}
      onSelectedModelsChange={setSelectedModels}
      onCustomApply={applyCustom}
      onRefresh={() => void refresh()}
    /></PageActions>
    <PageContent title={t("运行概览")} sections={sections} />
  </>;
}
