import { useEffect, useMemo, useState } from "react";
import { api, pluginText, type Overview } from "../../shared/api";
import { OverviewActivity } from "./overview/OverviewActivity";
import { DailyTokenUsageChart } from "./charts/DailyTokenUsageChart";
import { HomeMetrics } from "./metrics/HomeMetrics";
import { PageContent } from "../../shell/layout/PageContent";
import type { VirtualPageSection } from "../../shell/layout/VirtualPage";
import { OverviewTimeRangeFilter, type OverviewRangePreset, type QuickPreset } from "./overview/OverviewTimeRangeFilter";
import { PageActions } from "../../shell/PageActions";
import { appStore, useAppStore } from "../../shared/store/appStore";
import { formatTimeInput, parseTimeInput } from "../../shared/utils/parseTimeInput";
import { modelProviderName } from "../../shared/utils/modelProvider";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../../shared/ui/icons";
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
  const { overview, busy, models, plugins } = useAppStore();
  const { locale } = useI18n();
  const [preset, setPreset] = useState<OverviewRangePreset>("month");
  const [quick, setQuick] = useState<QuickPreset | null>(null);
  const [customRange, setCustomRange] = useState<TimeRange | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [appliedModels, setAppliedModels] = useState<string[]>([]);
  const [rangeOverview, setRangeOverview] = useState<Overview | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const selectedRange = useMemo(() => preset === "custom" ? customRange : presetRange(preset), [preset, customRange, refreshVersion, overview]);

  useEffect(() => {
    if (!selectedRange) return;
    let active = true;
    setRangeBusy(true);
    void api.overview({
      ...selectedRange,
      modelHashes: appliedModels,
    }).then((next) => {
      if (active) setRangeOverview(next);
    }).finally(() => {
      if (active) setRangeBusy(false);
    });
    return () => { active = false; };
  }, [preset, customRange, overview, refreshVersion, appliedModels]);

  const filteredOverview = rangeOverview ?? overview;
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
    await appStore.refresh();
    setRefreshVersion((version) => version + 1);
  };
  const iconFor = (type: string) => type === "anthropic" ? claudeIcon : openAiIcon;
  const modelOptions = [
    ...models.map((model) => ({
      value: model.model_hash,
      label: model.display_name,
      group: modelProviderName(model),
      icon: iconFor(model.type),
    })),
    ...plugins.flatMap((plugin) => plugin.providers.flatMap((provider) =>
      provider.configured ? provider.models.filter((model) => model.enabled).map((model) => ({
        value: model.id,
        label: model.displayName,
        group: pluginText(provider.displayName, locale) || model.pluginName,
        iconSrc: model.icon || undefined,
        icon: model.icon ? undefined : flatColorOrganizationIcon,
      })) : [],
    )),
  ];
  const sections: VirtualPageSection[] = [
    {
      key: "metrics",
      estimatedHeight: 130,
      content: <HomeMetrics data={metrics} />,
    },
    {
      key: "daily-token-usage",
      estimatedHeight: 240,
      content: <DailyTokenUsageChart
        data={dailyTokenUsage}
        granularity={filteredOverview.token_usage_granularity}
      />,
    },
    {
      key: "activity",
      estimatedHeight: 40,
      content: <OverviewActivity endMs={selectedRange?.endMs ?? Date.now()} modelHashes={appliedModels} />,
    },
  ];

  return <>
    <PageActions position="filters"><OverviewTimeRangeFilter
      value={preset}
      quick={quick}
      customOpen={customOpen}
      customStart={customStart}
      customEnd={customEnd}
      modelOptions={modelOptions}
      selectedModels={selectedModels}
      busy={busy || rangeBusy}
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
