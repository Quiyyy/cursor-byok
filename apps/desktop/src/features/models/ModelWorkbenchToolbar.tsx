import { Icon } from "../../shared/ui/Icon";
import { Select } from "../../shared/ui/Select";
import { TextInput } from "../../shared/ui/FormControls";
import { modelSearchIcon } from "../../shared/ui/workbenchIcons";
import type { CursorModelGrouping } from "./CursorModelCards";
import type { ModelStatusFilter } from "./modelWorkbench";
import styles from "./ModelWorkbench.module.scss";

export function ModelWorkbenchToolbar({ query, filter, grouping, onQuery, onFilter, onGrouping }: {
  query: string;
  filter: ModelStatusFilter;
  grouping: CursorModelGrouping;
  onQuery: (value: string) => void;
  onFilter: (value: ModelStatusFilter) => void;
  onGrouping: (value: CursorModelGrouping) => void;
}) {
  return <div className={styles.toolbar}>
    <label className={styles.search}>
      <Icon icon={modelSearchIcon} />
      <TextInput aria-label={t("搜索模型或来源")} placeholder={t("搜索模型或来源")} value={query} onChange={(event) => onQuery(event.target.value)} />
    </label>
    <Select ariaLabel={t("测试状态")} value={filter} onChange={(value) => onFilter(value as ModelStatusFilter)} options={[
      { value: "all", label: t("全部状态") },
      { value: "error", label: t("测试失败") },
      { value: "untested", label: t("未测试") },
    ]} />
    <Select ariaLabel={t("模型分组")} value={grouping} onChange={(value) => onGrouping(value as CursorModelGrouping)} options={[
      { value: "provider", label: t("按来源分组") },
      { value: "type", label: t("按协议分组") },
      { value: "flat", label: t("平铺与排序") },
    ]} />
  </div>;
}
