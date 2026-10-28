import { api } from "../../shared/api";
import { createStore } from "../../shared/store/createStore";
import type { PluginDescriptor, PluginRuntimeStatus } from "../../shared/api";
type PluginsState = {
  plugins: PluginDescriptor[];
  pluginRuntime: PluginRuntimeStatus | null;
  busy: boolean;
  error: string | null;
};
const state = createStore<PluginsState>({
  plugins: [],
  pluginRuntime: null,
  busy: false,
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
export const pluginsStore = {
  getSnapshot: state.getSnapshot,
  async refresh() {
    update({
      busy: true,
      error: null
    });
    await Promise.all([pluginsStore.refreshPluginRuntime(), pluginsStore.refreshPlugins()]);
    update({
      busy: false
    });
  },
  async initializePluginRuntime() {
    update({
      error: null
    });
    try {
      const pluginRuntime = await api.initializePluginRuntime();
      update({
        pluginRuntime
      });
      return pluginRuntime;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    }
  },
  async refreshPluginRuntime() {
    try {
      const wasReady = state.getSnapshot().pluginRuntime?.state === "ready";
      const pluginRuntime = await api.pluginRuntime();
      update({
        pluginRuntime
      });
      if (!wasReady && pluginRuntime.state === "ready") {
        const plugins = await api.plugins();
        update({
          plugins
        });
      }
      return pluginRuntime;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    }
  },
  async cancelPluginRuntimeInitialization() {
    try {
      const pluginRuntime = await api.cancelPluginRuntimeInitialization();
      update({
        pluginRuntime
      });
      return pluginRuntime;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    }
  },
  async refreshPlugins() {
    try {
      update({
        plugins: await api.plugins()
      });
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
  },
  async removePluginConfiguration(pluginId: string) {
    await perform(async () => {
      await api.removePluginConfiguration(pluginId);
      update({
        plugins: await api.plugins()
      });
    });
  }
};
export const usePluginsStore = state.useSnapshot;
