import { modelsStore } from "../features/models/state";
import { pluginsStore } from "../features/plugins/state";
import { cursorStore } from "../features/cursor/state";
import { callsStore } from "../features/calls/state";
import { settingsStore } from "../features/settings/state";
export async function initializeApp() {
  await Promise.allSettled([modelsStore.refresh(), pluginsStore.refresh(), cursorStore.refresh(), settingsStore.refresh()]);
}
export async function refreshPage(path: string) {
  switch (path) {
    case "/models":
      await Promise.allSettled([modelsStore.refresh(), pluginsStore.refreshPlugins()]);
      break;
    case "/providers":
      await pluginsStore.refresh();
      break;
    case "/calls":
      await callsStore.refreshCalls();
      break;
    case "/settings":
      await settingsStore.refresh();
      break;
  }
}
