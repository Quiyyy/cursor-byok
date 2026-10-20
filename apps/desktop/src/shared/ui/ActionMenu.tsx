import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { chevronDownIcon } from "./icons";
import { moreActionsIcon } from "./workbenchIcons";
import styles from "./ActionMenu.module.scss";

export type ActionMenuItem =
  | {
      id: string;
      label: string;
      type?: "action";
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      id: string;
      label: string;
      type: "text";
    };

/** 触发器 + 动作列表的下拉菜单,用于容纳卡片上的次要操作。 */
export function ActionMenu({ label, items, disabled, iconOnly = false }: {
  label: string;
  items: ActionMenuItem[];
  disabled?: boolean;
  iconOnly?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    return autoUpdate(trigger.current, menu.current, () =>
      void computePosition(trigger.current!, menu.current!, {
        placement: "bottom-end",
        middleware: [offset(5), flip({ padding: 10 }), shift({ padding: 10 })],
      }).then(({ x, y }) => setPosition({ left: x, top: y })));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return <>
    <Button
      ref={trigger}
      size="small"
      variant={iconOnly ? "ghost" : "secondary"}
      className={iconOnly ? styles.iconTrigger : undefined}
      disabled={disabled}
      aria-label={label}
      title={iconOnly ? label : undefined}
      aria-haspopup="menu"
      aria-controls={open ? menuId : undefined}
      aria-expanded={open}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      {iconOnly ? <Icon icon={moreActionsIcon} size="1.2em" /> : <>
        {label}
        <Icon icon={chevronDownIcon} size="1em" className={open ? styles.openIcon : undefined} />
      </>}
    </Button>
    {open && createPortal(
      <div
        id={menuId}
        ref={menu}
        className={styles.menu}
        role="menu"
        aria-label={label}
        style={{ left: position.left, top: position.top }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "Tab") {
            setOpen(false);
          } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const options = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
            if (!options.length) return;
            const current = options.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
            options[next]?.focus();
          }
        }}
      >
        {items.map((item) => item.type === "text" ? (
          <span key={item.id} className={styles.textItem}>
            {item.label}
          </span>
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>,
      document.body,
    )}
  </>;
}
