import appIcon from "../../src-tauri/icons/icon.svg";
import type { DesktopPlatform } from "../shared/native/platform";
import { WindowControls } from "./WindowControls";
import { MacTrafficLights } from "./MacTrafficLights";
import styles from "./AppHeader.module.scss";

type AppHeaderProps = {
  platform: DesktopPlatform;
  nativeDesktop: boolean;
};

export function AppHeader({ platform, nativeDesktop }: AppHeaderProps) {
  const showMacTrafficLights = !nativeDesktop && platform === "macos";
  const showNativeUi = nativeDesktop && platform !== "macos";
  return <header className={styles.root} data-macos={platform === "macos" || undefined}>
    <div className={styles.dragLayer} data-tauri-drag-region aria-hidden="true" />
    <div className={styles.uiLayer}>
      {showMacTrafficLights && <MacTrafficLights />}
      <div className={styles.identity} aria-label="Cursor BYOK">
        <img src={appIcon} alt="" />
        <span>Cursor BYOK</span>
      </div>
      {showNativeUi && <WindowControls />}
    </div>
  </header>;
}
