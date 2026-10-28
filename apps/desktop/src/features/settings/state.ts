import { api } from "../../shared/api";
import { createStore } from "../../shared/store/createStore";
import type { TokenPricingSettings, PortSettings } from "../../shared/api";
import { applyTheme, isThemeId, type ThemeId } from "../../shared/theme/theme";
export const DEFAULT_TOKEN_PRICING: TokenPricingSettings = {
  input_per_million: 5.0,
  output_per_million: 25.0,
  cache_read_per_million: 0.5,
  cache_write_per_million: 6.25
};
const savedTheme = (): ThemeId => {
  const value = localStorage.getItem("cursor-byok.theme");
  return isThemeId(value) ? value : "default-dark";
};
type SettingsState = {
  detailed: boolean;
  ports: PortSettings;
  pricing: TokenPricingSettings;
  theme: ThemeId;
  error: string | null;
};
const state = createStore<SettingsState>({
  detailed: false,
  ports: {
    proxy_port: 0,
    service_port: 0
  },
  pricing: DEFAULT_TOKEN_PRICING,
  theme: savedTheme(),
  error: null
});
const update = state.update;
async function perform(task: () => Promise<void>) {
  update({
    error: null
  });
  try {
    await task();
  } catch (cause) {
    update({
      error: cause instanceof Error ? cause.message : String(cause)
    });
  }
}
export const settingsStore = {
  getSnapshot: state.getSnapshot,
  async refresh() {
    await Promise.all([perform(async () => update({
      detailed: (await api.observability()).detailed
    })), perform(async () => update({
      ports: await api.ports()
    })), perform(async () => update({
      pricing: await api.pricingSettings()
    }))]);
  },
  async updateDetailed(detailed: boolean) {
    await perform(async () => update(await api.setObservability(detailed)));
  },
  async updatePorts(ports: PortSettings) {
    try {
      update({
        error: null
      });
      update({
        ports: await api.setPorts(ports)
      });
      return true;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return false;
    }
  },
  async updatePricingSettings(pricing: TokenPricingSettings) {
    try {
      update({
        error: null
      });
      update({
        pricing: await api.setPricingSettings(pricing)
      });
      return true;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return false;
    }
  },
  selectTheme(theme: ThemeId) {
    localStorage.setItem("cursor-byok.theme", theme);
    applyTheme(theme);
    update({
      theme
    });
  }
};
export const useSettingsStore = state.useSnapshot;
