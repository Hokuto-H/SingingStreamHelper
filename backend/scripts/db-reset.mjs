/**
 * テスト用 DB を作り直す。**全部消える。**
 *
 *   npm run db:reset -- --yes
 *
 * ─────────────────────────────────────────────────────────
 * ## なぜ要るのか
 *
 * `CREATE TABLE IF NOT EXISTS` は**既存のテーブルに列を足さない**。
 * 開発中に列を追加したあと migrate を流し直しても、
 * テーブルは古いままで、実行時に
 * `no such column: s.is_public` のようなエラー (HTTP 500) になる。
 *
 * 本番なら ALTER TABLE で移行するが、
 * 中身が捨ててよいテスト DB なら作り直すほうが早くて確実。
 * ─────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { env } from "./env.mjs";

if (!process.argv.includes("--yes")) {
  console.error(
    "\n★ このコマンドはテーブルを全部消します。" +
      "\n  本当に実行するなら:  npm run db:reset -- --yes\n",
  );
  process.exit(1);
}

const url = env("TURSO_DATABASE_URL");
const db = createClient({ url, authToken: env("TURSO_AUTH_TOKEN") });

console.log(`接続先: ${url}`);

// 外部キーの向きがあるので、参照している側から消す
const ORDER = [
  "performances",
  "streamer_tokens",
  "recovery_challenges",
  "streamers",
  "songs",
];
for (const t of ORDER) {
  await db.execute(`DROP TABLE IF EXISTS ${t}`);
  console.log(`  DROP ${t}`);
}

for (const f of ["schema.sql", "schema-streamers.sql"]) {
  await db.executeMultiple(readFileSync(f, "utf8"));
  console.log(`  ${f} を流した`);
}
console.log("\n作り直しました。npm run doctor で確認してください。");
