import { useSyncExternalStore } from "react";
import { message } from "../ui/message";

/** Small external-store primitive; each feature owns its snapshot and actions. */
export function createStore<S extends { error: string | null }>(initial: S) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const getSnapshot = () => snapshot;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const update = (patch: Partial<S>) => {
    const previousError = snapshot.error;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
    if (snapshot.error && snapshot.error !== previousError) message(snapshot.error);
  };
  return { getSnapshot, subscribe, update, useSnapshot: () => useSyncExternalStore(subscribe, getSnapshot) };
}
