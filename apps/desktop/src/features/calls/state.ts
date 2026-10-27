import { api } from "../../shared/api";
import { createStore } from "../../shared/store/createStore";
import type { LlmCall } from "../../shared/api";
type CallsState = {
  calls: LlmCall[];
  error: string | null;
};
const state = createStore<CallsState>({
  calls: [],
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
export const callsStore = {
  getSnapshot: state.getSnapshot,
  async refreshCalls() {
    try {
      update({
        calls: await api.calls()
      });
    } catch (cause) {
      update({
        error: cause instanceof Error ? cause.message : String(cause)
      });
    }
  },
  async openCallDetails(callId: string) {
    await perform(() => api.openCallDetails(callId));
  }
};
export const useCallsStore = state.useSnapshot;
