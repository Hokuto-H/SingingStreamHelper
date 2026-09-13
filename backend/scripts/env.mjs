/**
 * .dev.vars を読む小さなパーサ。
 *
 * wrangler dev と同じファイルを migrate / smoke からも読めるようにして、
 * 「wrangler では動くのにスクリプトでは動かない」を無くす。
 *
 * 対応する書き方:
 *   KEY=value
 *   KEY="value"          … \n などのエスケープを展開する
 *   KEY='value'          … 中身をそのまま (Google の秘密鍵はこちら)
 *   # 行頭 # はコメント
 */
import { readFileSync, existsSync } from "node:fs";

export function loadDevVars(path = ".dev.vars") {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      // シングルクォート: 中身をそのまま。
      // ★ Google の秘密鍵は "\n" (バックスラッシュ + n) のまま渡す必要がある。
      val = val.slice(1, -1);
    } else if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    out[key] = val;
  }
  return out;
}

/** .dev.vars → 環境変数 の順で探す (環境変数のほうが強い) */
export function env(name, { required = true } = {}) {
  const vars = (env._cache ??= loadDevVars());
  const v = process.env[name] ?? vars[name];
  if (!v && required) {
    console.error(
      `\n[設定エラー] ${name} が見つかりません。` +
        `\n  .dev.vars に書くか、環境変数で渡してください。` +
        `\n  例: ${name}=... npm run <script>\n`,
    );
    process.exit(1);
  }
  return v ?? "";
}
