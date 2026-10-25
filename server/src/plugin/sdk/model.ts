import type { JsonValue, PluginContext } from "./plugin.ts";
import type { ResourceSnapshot } from "./resource.ts";

export type ModelCapabilities = {
  images?: boolean;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
};

export type ModelDefinition = {
  id: string;
  displayName: string;
  description?: string;
  maxOutputTokens?: number;
  contextWindowTokens?: number;
  capabilities?: ModelCapabilities;
  /** 之后的调用原样传回;永远不会展示给用户。 */
  privateData?: JsonValue;
};

/** 宿主目录中持久化的一条模型。 */
export type ModelSnapshot = ModelDefinition;

export type ModelListInput = {
  /** 模型发现需要认证时为首个可用资源,否则为 null。 */
  resource: ResourceSnapshot | null;
};

export type ModelSupport = {
  /** 成功结果整体替换目录,空数组清空目录;失败须抛出错误,宿主保留上次成功的目录。 */
  list(input: ModelListInput, context: PluginContext): Promise<ModelDefinition[]>;
};
