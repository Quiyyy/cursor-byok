import type { Locale } from "../../i18n/runtime";
import { pluginText, type Model, type PluginDescriptor } from "../api";
import type { ModelSelectOption } from "../ui/ModelSelect";
import { claudeIcon, flatColorOrganizationIcon, openAiIcon } from "../ui/icons";
import { modelProviderName } from "./modelProvider";

export function configuredModelOptions(models: Model[], plugins: PluginDescriptor[], locale: Locale): ModelSelectOption[] {
  const options: ModelSelectOption[] = models.map((model) => ({
    value: model.model_hash,
    label: model.display_name && model.display_name !== model.model_id
      ? `${model.display_name}（${model.model_id}）`
      : model.display_name || model.model_id,
    group: modelProviderName(model),
    icon: model.type === "anthropic" ? claudeIcon : openAiIcon,
  }));
  for (const plugin of plugins) {
    for (const provider of plugin.providers) {
      if (!provider.configured) continue;
      for (const model of provider.models.filter((model) => model.enabled)) {
        options.push({
          value: model.id,
          label: model.displayName,
          group: pluginText(provider.displayName, locale) || plugin.name,
          iconSrc: model.icon || undefined,
          icon: model.icon ? undefined : flatColorOrganizationIcon,
        });
      }
    }
  }
  return options;
}
