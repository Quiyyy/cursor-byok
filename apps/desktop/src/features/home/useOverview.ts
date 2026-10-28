import { useEffect, useState } from "react";
import { api, type Overview } from "../../shared/api";
import { createStore } from "../../shared/store/createStore";
import { message } from "../../shared/ui/message";
const invalidation = createStore({
  revision: 0,
  error: null as string | null
});
export const invalidateOverview = () => invalidation.update({
  revision: invalidation.getSnapshot().revision + 1
});
const empty: Overview = {
  metrics: {
    llm_calls: 0,
    successful_calls: 0,
    failed_calls: 0,
    token_usage: 0,
    prompt_tokens: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    output_tokens: 0
  },
  token_usage_granularity: "day",
  token_usage_series: []
};
export function useOverview(range: {
  startMs: number;
  endMs: number;
} | null, modelHashes: string[], refreshVersion: number) {
  const {
    revision
  } = invalidation.useSnapshot();
  const [overview, setOverview] = useState(empty);
  const [busy, setBusy] = useState(false);
  const startMs = range?.startMs,
    endMs = range?.endMs;
  useEffect(() => {
    if (startMs == null || endMs == null) return;
    let active = true;
    setBusy(true);
    void api.overview({
      startMs,
      endMs,
      modelHashes
    }).then(next => {
      if (active) setOverview(next);
    }).catch(cause => {
      if (active) message(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => {
      active = false;
    };
  }, [startMs, endMs, modelHashes, refreshVersion, revision]);
  return {
    overview,
    busy
  };
}
