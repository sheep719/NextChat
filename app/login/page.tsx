/**
 * 登录页路由 /login。
 *
 * 为什么单独一条路由而不是 HashRouter 内的一个页面：
 * Home 内部用的是 HashRouter（`/#/chat/...`），所有子页面共用一个 Next 路由；
 * 登录态校验发生在 HashRouter 挂载之前，需要一次真实的路由跳转来彻底拦住主页渲染。
 */
import { LoginPage } from "../components/login";

export default function Login() {
  return <LoginPage />;
}
