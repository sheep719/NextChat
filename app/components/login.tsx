"use client";

require("../polyfill");

/**
 * 必须先 import utils，再 import 其他 UI/locales 模块。
 *
 * 原因：App 内存在一条循环依赖链
 *   locales/index → cn.ts → store/config → utils/store → utils/indexedDB-storage
 *     → utils(utils.ts) → store/index → store/chat → locales/index
 * 若从 locales 先进入，store/chat 会在 locales/index 完成初始化前访问它的默认导出，
 * SSR 阶段直接抛 `Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization`。
 * home.tsx 之所以没问题，正是因为它在 `../locales` 之前先 import 了 `../utils`。
 */
import "../utils";

import authStyles from "./auth.module.scss";
import uiStyles from "./ui-lib.module.scss";
import { useEffect, useState } from "react";
import { IconButton } from "./button";
import { PasswordInput } from "./ui-lib";
import clsx from "clsx";
import Locale from "../locales";
import BotIcon from "../icons/bot.svg";
import { useAuthStore } from "../store/auth";

type Mode = "login" | "register";

const inputClass = clsx(uiStyles["input"], authStyles["auth-input"]);

export function LoginPage() {
  const hydrated = useAuthStore((s) => s._hasHydrated);
  const gatewayUrlInStore = useAuthStore((s) => s.gatewayUrl);

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // IndexedDB 里的网关地址要等 hydration 完成后才读得到
  useEffect(() => {
    if (hydrated) setGatewayUrl(gatewayUrlInStore);
  }, [hydrated, gatewayUrlInStore]);

  const isRegister = mode === "register";

  const submit = async () => {
    const name = username.trim();
    if (!name || !password) {
      setError(Locale.GatewayAuth.RequiredFields);
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");

    try {
      const auth = useAuthStore.getState();
      auth.setGatewayUrl(gatewayUrl);

      if (isRegister) {
        await auth.register(name, password, email);
        setNotice(Locale.GatewayAuth.SuccessRegister);
      } else {
        await auth.login(name, password);
        setNotice(Locale.GatewayAuth.SuccessLogin);
      }

      // 回主页；Home 挂载后会拉取云端快照并与本机会话合并
      setTimeout(() => {
        window.location.href = "/";
      }, 400);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={authStyles["auth-page"]}>
      <div className={clsx("no-dark", authStyles["auth-logo"])}>
        <BotIcon />
      </div>

      <div className={authStyles["auth-title"]}>
        {isRegister
          ? Locale.GatewayAuth.RegisterTitle
          : Locale.GatewayAuth.Title}
      </div>
      <div className={authStyles["auth-tips"]}>
        {isRegister ? Locale.GatewayAuth.RegisterTips : Locale.GatewayAuth.Tips}
      </div>

      <input
        className={inputClass}
        type="text"
        placeholder={Locale.GatewayAuth.UsernamePlaceholder}
        aria-label={Locale.GatewayAuth.Username}
        value={username}
        autoComplete="username"
        onChange={(e) => setUsername(e.currentTarget.value)}
      />

      <PasswordInput
        className={authStyles["auth-input"]}
        aria={Locale.Settings.ShowPassword}
        aria-label={Locale.GatewayAuth.Password}
        value={password}
        type="password"
        placeholder={Locale.GatewayAuth.PasswordPlaceholder}
        autoComplete={isRegister ? "new-password" : "current-password"}
        onChange={(e) => setPassword(e.currentTarget.value)}
      />

      {isRegister && (
        <input
          className={inputClass}
          type="email"
          placeholder={Locale.GatewayAuth.Email}
          aria-label={Locale.GatewayAuth.Email}
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      )}

      {showAdvanced && (
        <input
          className={inputClass}
          type="text"
          placeholder={Locale.GatewayAuth.GatewayUrlPlaceholder}
          aria-label={Locale.GatewayAuth.GatewayUrl}
          value={gatewayUrl}
          onChange={(e) => setGatewayUrl(e.currentTarget.value)}
        />
      )}

      <div className={authStyles["auth-actions"]}>
        <IconButton
          text={
            busy
              ? Locale.GatewayAuth.Submitting
              : isRegister
              ? Locale.GatewayAuth.RegisterSubmit
              : Locale.GatewayAuth.LoginSubmit
          }
          type="primary"
          onClick={submit}
        />
        <IconButton
          text={
            showAdvanced
              ? Locale.GatewayAuth.HideAdvanced
              : Locale.GatewayAuth.ShowAdvanced
          }
          onClick={() => setShowAdvanced((v) => !v)}
        />
        <IconButton
          text={
            isRegister
              ? Locale.GatewayAuth.ToLogin
              : Locale.GatewayAuth.ToRegister
          }
          onClick={() => {
            setMode(isRegister ? "login" : "register");
            setError("");
            setNotice("");
          }}
        />
      </div>

      {notice ? <div className={authStyles["auth-tips"]}>{notice}</div> : null}
      {error ? (
        <div
          className={authStyles["auth-tips"]}
          style={{ color: "var(--danger, #d9534f)" }}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
