export function callStatusLabel(status: string) {
  switch (status) {
    case "completed": return t("成功");
    case "failed": return t("失败");
    case "cancelled": return t("已取消");
    case "running": return t("进行中");
    default: return status;
  }
}
