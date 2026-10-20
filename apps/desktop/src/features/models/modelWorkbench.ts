import type { Model, PluginModelDescriptor } from "../../shared/api";
import type { CursorModelTestState } from "./CursorModelTestResult";

export type ModelStatusFilter = "all" | "error" | "untested";

export function matchesModelStatus(state: CursorModelTestState | undefined, filter: ModelStatusFilter) {
  if (filter === "error") return state?.status === "error";
  if (filter === "untested") return !state || state.status === "cancelled";
  return true;
}

export function matchesModelSearch(model: Model | PluginModelDescriptor, query: string) {
  const values = "model_hash" in model
    ? [model.display_name, model.model_id, model.base_url, model.group_name ?? "", model.type]
    : [model.displayName, model.modelId, model.pluginName, model.providerType];
  return values.join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
