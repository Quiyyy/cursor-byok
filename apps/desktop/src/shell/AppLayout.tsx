import { useCallback, useState } from "react";
import type { IconifyIcon } from "@iconify/react/offline";
import KeepAliveRouteOutlet from "keepalive-for-react-router";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../shared/api";
import { PageLayout } from "./layout/PageLayout";
import { Card } from "../shared/ui/Card";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import controls from "../shared/ui/Controls.module.scss";
import { Icon } from "../shared/ui/Icon";
import { TooltipTrigger } from "../shared/ui/TooltipTrigger";
import { refreshIcon } from "../shared/ui/icons";
import { accountsIcon, callsIcon, connectionIcon, guideIcon, modelsIcon, overviewIcon, preferencesIcon } from "../shared/ui/workbenchIcons";
import { useMessage } from "../shared/ui/message";
import { VirtualList } from "../shared/virtual/VirtualList";
import { appStore, useAppStore } from "../shared/store/appStore";
import { useUpdateStore } from "../shared/store/updateStore";
import styles from "./AppLayout.module.scss";
import { PageActionsTarget } from "./PageActions";

type MenuItem = { path: string; label: string; icon: IconifyIcon };

const keptAlivePages = ["/", "/calls", "/settings", "/models", "/providers"];
const tutorialReadStorageKey = "cursor-byok:tutorial-read";
const tutorialUrl = "https://github.com/Quiyyy/cursor-byok/blob/main/README-CN.md";

export function AppLayout() {
  const { busy, cursorHarness } = useAppStore();
  const { availableVersion } = useUpdateStore();
  const message = useMessage();
  const location = useLocation();
  const [leftActionTarget, setLeftActionTarget] = useState<HTMLDivElement | null>(null);
  const [rightActionTarget, setRightActionTarget] = useState<HTMLDivElement | null>(null);
  const [filterTarget, setFilterTarget] = useState<HTMLDivElement | null>(null);
  const [confirmTutorial, setConfirmTutorial] = useState(false);
  const [tutorialRead, setTutorialRead] = useState(() => {
    try {
      return localStorage.getItem(tutorialReadStorageKey) === "true";
    } catch {
      return false;
    }
  });
  const menuItems: MenuItem[] = [
    { path: "/", label: t("运行概览"), icon: overviewIcon },
    { path: "/models", label: t("模型管理"), icon: modelsIcon },
    { path: "/providers", label: t("账号连接"), icon: accountsIcon },
    { path: "/calls", label: t("调用记录"), icon: callsIcon },
  ];
  const connected = cursorHarness?.integration === "enabled" && cursorHarness.settings_applied && cursorHarness.ca === "ready";

  const openTutorial = useCallback(() => {
    setConfirmTutorial(false);
    void api.openExternalUrl(tutorialUrl)
      .then(() => {
        setTutorialRead(true);
        try {
          localStorage.setItem(tutorialReadStorageKey, "true");
        } catch {
          // Read state remains valid for the current session when storage is unavailable.
        }
      })
      .catch((cause) => message(cause instanceof Error ? cause.message : String(cause)));
  }, [message]);

  return <PageLayout className={styles.root}>
    <Card as="aside" className={styles.menuCard}>
      <nav className={styles.navigation} aria-label={t("主菜单")}>
        <div className={styles.navigationGroup}>{t("工作空间")}</div>
        <VirtualList
          items={menuItems}
          itemKey="path"
          estimatedItemHeight={40}
          itemGap={3}
          className={`${styles.navigationList} scroll-shadow-bottom`}
        >
          {(item) => <div className={styles.navigationRow} key={item.path}>
            <NavLink to={item.path} end={item.path === "/"}>
              <Icon icon={item.icon} size="1.2em" />
              <span>{item.label}</span>
            </NavLink>
          </div>}
        </VirtualList>
        <div className={styles.navigationFooter}>
          {document.documentElement.dataset.demo && <span className={styles.demoNotice}>{t("演示模式 · 数据仅保存在内存")}</span>}
          <NavLink to="/models" className={styles.connectionStatus} data-connected={connected || undefined}>
            <Icon icon={connectionIcon} />
            <span>{!cursorHarness ? t("正在检查接入") : connected ? t("Cursor 已接管") : cursorHarness.integration === "degraded" ? t("Cursor 接入需检查") : t("Cursor 未接管")}</span>
          </NavLink>
          <div className={styles.navigationRow}>
            <NavLink to="/settings"><Icon icon={preferencesIcon} size="1.2em" /><span>{t("系统设置")}</span>{availableVersion && <span className={styles.menuIndicatorDot} aria-hidden="true" />}</NavLink>
          </div>
          <div className={styles.navigationRow}>
            <button type="button" onClick={() => setConfirmTutorial(true)} aria-label={t("使用教程")}><Icon icon={guideIcon} size="1.2em" /><span>{t("使用教程")}</span>{!tutorialRead && <span className={styles.menuIndicatorDot} aria-hidden="true" />}</button>
          </div>
        </div>
      </nav>
    </Card>
    <ConfirmDialog
      id="open-tutorial-dialog"
      open={confirmTutorial}
      title={t("打开使用教程？")}
      cancelLabel={t("取消")}
      confirmLabel={t("打开教程")}
      onCancel={() => setConfirmTutorial(false)}
      onConfirm={openTutorial}
    >
      <p>{t("将在系统浏览器中打开使用教程，是否继续？")}</p>
    </ConfirmDialog>
    <main className={styles.content}>
      <div className={styles.actionRegion}>
        <Card className={styles.actions}>
          <div ref={setLeftActionTarget} className={styles.pageActions} />
          {location.pathname !== "/" && <TooltipTrigger label={t("刷新")}><button className={controls.iconButton} aria-label={t("刷新")} disabled={busy} onClick={() => void appStore.refresh()}>
            <Icon className={busy ? controls.spin : ""} icon={refreshIcon} size="1.1em" />
          </button></TooltipTrigger>}
          <div ref={setRightActionTarget} className={styles.pageActions} />
        </Card>
      </div>
      <div ref={setFilterTarget} className={styles.filterRegion} />
      <PageActionsTarget.Provider value={{ left: leftActionTarget, right: rightActionTarget, filters: filterTarget }}>
        <KeepAliveRouteOutlet
          activeCacheKey={location.pathname}
          include={keptAlivePages}
          max={keptAlivePages.length}
          enableActivity
          containerClassName={styles.keepAliveContainer}
          cacheNodeClassName={styles.keepAlivePage}
        />
      </PageActionsTarget.Provider>
    </main>
  </PageLayout>;
}
