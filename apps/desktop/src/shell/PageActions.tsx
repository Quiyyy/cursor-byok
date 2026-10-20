import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useKeepAliveContext } from "keepalive-for-react";

type PageActionsTargets = {
  left: HTMLElement | null;
  right: HTMLElement | null;
  filters: HTMLElement | null;
};

export const PageActionsTarget = createContext<PageActionsTargets>({ left: null, right: null, filters: null });

export function PageActions({ children, position = "right" }: { children: ReactNode; position?: keyof PageActionsTargets }) {
  const targets = useContext(PageActionsTarget);
  const { active } = useKeepAliveContext();
  const target = targets[position];
  return active && target ? createPortal(children, target) : null;
}
