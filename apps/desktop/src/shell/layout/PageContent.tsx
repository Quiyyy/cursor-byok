import type { ReactNode } from "react";
import type { VirtualPageSection } from "./VirtualPage";
import { VirtualPage } from "./VirtualPage";
import styles from "./PageContent.module.scss";

export function PageContent({ title, sections, contentClassName, fixed = false }: { title?: ReactNode; sections: VirtualPageSection[]; contentClassName?: string; fixed?: boolean }) {
  return <div className={styles.root}>
    <div className={styles.headerBackdrop} aria-hidden="true" />
    {title != null && <h1 className={styles.title}>{title}</h1>}
    {fixed
      ? <div className={[styles.fixedContent, contentClassName].filter(Boolean).join(" ")}>{sections.map((section) => <section className={styles.fixedSection} key={section.key}>{section.content}</section>)}</div>
      : <VirtualPage sections={sections} contentClassName={contentClassName} />}
  </div>;
}
