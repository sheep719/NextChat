/**
 * 用量统计页的标准路径别名 /stats。
 *
 * 实际面板挂在 HashRouter 子页 `/#/usage`（见 app/components/home.tsx 的
 * Path.Usage 路由）。验收标准要求 /stats 路由可达——这里做一次服务端重定向，
 * 登录守卫语义不变（未登录访问 /stats 与访问 / 一样会被 /login 拦截）。
 */
import { redirect } from "next/navigation";

export default function Stats() {
  redirect("/#usage");
}
