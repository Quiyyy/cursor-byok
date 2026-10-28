import { useState } from "react";
import type { IconifyIcon } from "@iconify/react/offline";
import KeepAliveRouteOutlet from "keepalive-for-react-router";
import { NavLink, useLocation } from "react-router-dom";
import { PageLayout } from "./layout/PageLayout";
import { Card } from "../shared/ui/Card";
import controls from "../shared/ui/Controls.module.scss";
import { Icon } from "../shared/ui/Icon";
import { TooltipTrigger } from "../shared/ui/TooltipTrigger";
import { refreshIcon } from "../shared/ui/icons";
import { accountsIcon, callsIcon, modelsIcon, overviewIcon, preferencesIcon } from "../shared/ui/workbenchIcons";
import { CursorTakeover } from "../features/cursor/CursorTakeover";
import { VirtualList } from "../shared/virtual/VirtualList";
import {refreshPage} from "./refresh";
import { useUpdateStore } from "../shared/store/updateStore";
import styles from "./AppLayout.module.scss";
import { PageActionsTarget } from "./PageActions";

type MenuItem = { path: string; label: string; icon: IconifyIcon };

const keptAlivePages = ["/", "/calls", "/settings", "/models", "/providers"];

export function AppLayout() {
  const [busy,setBusy] = useState(false);
  const { availableVersion } = useUpdateStore();
  const location = useLocation();
  const [leftActionTarget, setLeftActionTarget] = useState<HTMLDivElement | null>(null);
  const [rightActionTarget, setRightActionTarget] = useState<HTMLDivElement | null>(null);
  const [filterTarget, setFilterTarget] = useState<HTMLDivElement | null>(null);
  const menuItems: MenuItem[] = [
    { path: "/", label: t("运行概览"), icon: overviewIcon },
    { path: "/models", label: t("模型管理"), icon: modelsIcon },
    { path: "/providers", label: t("账号连接"), icon: accountsIcon },
    { path: "/calls", label: t("调用记录"), icon: callsIcon },
  ];

  return <PageLayout className={styles.root}>
    <aside className={styles.sidebar}>
      <nav className={styles.navigation} aria-label={t("主菜单")}>
        <div className={styles.navigationHeader}><CursorTakeover /></div>
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
          <div className={styles.navigationRow}>
            <NavLink to="/settings"><Icon icon={preferencesIcon} size="1.2em" /><span>{t("系统设置")}</span>{availableVersion && <span className={styles.menuIndicatorDot} aria-hidden="true" />}</NavLink>
          </div>
        </div>
      </nav>
    </aside>
    <main className={styles.content}>
      <div className={styles.actionRegion}>
        <Card className={styles.actions}>
          <div ref={setLeftActionTarget} className={styles.pageActions} />
          {location.pathname !== "/" && <TooltipTrigger label={t("刷新")}><button className={controls.iconButton} aria-label={t("刷新")} disabled={busy} onClick={() => {setBusy(true); void refreshPage(location.pathname).finally(()=>setBusy(false));}}>
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
