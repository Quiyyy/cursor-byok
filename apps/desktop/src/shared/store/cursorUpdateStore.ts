import { useSyncExternalStore } from "react";
import { api, type CursorUpdateStatus } from "../api";

type Snapshot = { status: CursorUpdateStatus | null; pending: boolean; error: string | null };
let snapshot: Snapshot = { status: null, pending: false, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let reading: Promise<void> | undefined;
let revision = 0;
function publish(patch: Partial<Snapshot>) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(); }
function schedule() {
  clearTimeout(timer);
  if (listeners.size && snapshot.status?.busy) timer = setTimeout(() => void cursorUpdateStore.refresh(), 1000);
}
async function perform(action: () => Promise<CursorUpdateStatus>) {
  if (snapshot.pending) return;
  revision++;
  publish({ pending: true, error: null });
  try { publish({ status: await action() }); }
  catch (error) {
    const status = await api.cursorUpdateStatus().catch(() => null);
    publish({ ...(status ? { status } : {}), error: error instanceof Error ? error.message : String(error) });
  }
  finally { publish({ pending: false }); schedule(); }
}
export const cursorUpdateStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    schedule();
    return () => { listeners.delete(listener); if (!listeners.size) clearTimeout(timer); };
  },
  getSnapshot: () => snapshot,
  refresh(): Promise<void> {
    if (reading) return reading;
    const startedAtRevision = revision;
    reading = (async () => {
      try { const status = await api.cursorUpdateStatus(); if (startedAtRevision === revision && !snapshot.pending) publish({ status, error: null }); }
      catch (error) { if (startedAtRevision === revision && !snapshot.pending) publish({ error: error instanceof Error ? error.message : String(error) }); }
      finally { reading = undefined; schedule(); }
    })();
    return reading;
  },
  configure: (enabled: boolean) => perform(() => api.configureCursorUpdates(enabled)),
  check: () => perform(api.checkCursorUpdate),
  cancel: () => perform(api.cancelCursorUpdateCheck),
  recover: () => perform(api.recoverCursorUpdate),
  install: (id: string) => perform(() => api.installCursorUpdate(id)),
};
export function useCursorUpdateStore() { return useSyncExternalStore(cursorUpdateStore.subscribe, cursorUpdateStore.getSnapshot); }
