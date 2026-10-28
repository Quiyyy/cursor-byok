import { api } from "../../shared/api";
import { createStore } from "../../shared/store/createStore";
import type { CursorHarnessStatus } from "../../shared/api";
type CursorState = {
  cursorHarness: CursorHarnessStatus | null;
  cursorBusy: boolean;
  busy: boolean;
  error: string | null;
};
const state = createStore<CursorState>({
  cursorHarness: null,
  cursorBusy: false,
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
export const cursorStore = {
  getSnapshot: state.getSnapshot,
  async refresh() {
    update({
      busy: true
    });
    await perform(async () => update({
      cursorHarness: await api.cursorHarness()
    }));
    update({
      busy: false
    });
  },
  async initializeCursorCa() {
    update({
      cursorBusy: true,
      error: null
    });
    try {
      const status = await api.initializeCursorCa();
      update({
        cursorHarness: status
      });
      return status;
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
      return null;
    } finally {
      update({
        cursorBusy: false
      });
    }
  },
  async setCursorEnabled(enabled: boolean) {
    update({
      cursorBusy: true,
      error: null
    });
    try {
      update({
        cursorHarness: await api.setCursorEnabled(enabled)
      });
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      update({
        cursorBusy: false
      });
    }
  }
};
export const useCursorStore = state.useSnapshot;
