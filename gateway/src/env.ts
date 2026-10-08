/**
 * 最小 .env 加载器（避免额外依赖）。
 * 仅支持 KEY=VALUE 单行格式，# 开头注释，忽略空行与引号。
 */
import fs from "node:fs";
import path from "node:path";

export function loadEnv(file = ".env"): void {
  const envPath = path.resolve(process.cwd(), file);
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
