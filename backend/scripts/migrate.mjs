/**
 * Turso にスキーマを流す。
 *
 *   npm run db:migrate
 *
 * ─────────────────────────────────────────────────────────
 * ## なぜ `turso db shell < schema.sql` ではなくスクリプトなのか
 *
 * こちらのスキーマファイルは**コメントの中に `;` が入っている**
 * (移行用の SQL を `--` でコメントアウトしてあるため)。
 * 文を `;` で切って送るタイプのクライアントだと、
 * コメントの途中で切れて構文エラーになることがある。
 *
 * `executeMultiple()` は**スクリプト全体をそのままサーバに渡す**ので、
 * コメントも複数文もサーバ側の SQLite パーサがそのまま解釈する。
 * WSL でも Windows でも、シェルの引用符の違いに悩まされない。
 *
 * ## 何度でも流してよい
 *
 * 全部 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` なので、
 * 既に作ってあるものは黙って飛ばされる。
 * ただし**列の追加は行われない**。列を足したときは
 * schema-streamers.sql 末尾のコメントにある ALTER 文を手で流すこと。
 * ─────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { env } from "./env.mjs";

const FILES = ["schema.sql", "schema-streamers.sql"];

const url = env("TURSO_DATABASE_URL");
const authToken = env("TURSO_AUTH_TOKEN");

console.log(`接続先: ${url}`);
const db = createClient({ url, authToken });

for (const f of FILES) {
  process.stdout.write(`  ${f} ... `);
  try {
    await db.executeMultiple(readFileSync(f, "utf8"));
    console.log("OK");
  } catch (e) {
    console.log("失敗");
    console.error(`\n${e?.message ?? e}\n`);
    process.exit(1);
  }
}

// 出来上がりを確認する
const tables = await db.execute(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`,
);
const indexes = await db.execute(
  `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name`,
);

console.log("\nテーブル:");
for (const r of tables.rows) console.log(`  - ${r.name}`);
console.log("インデックス:");
for (const r of indexes.rows) console.log(`  - ${r.name}`);

// 列がちゃんと入っているかも見ておく (移行忘れの検出)
const want = {
  streamers: [
    "repertoire_sheet", "history_sheet", "timezone",
    "spreadsheet_title", "title_synced_at", "is_public",
  ],
  streamer_tokens: ["scope"],
  performances: ["stream_url", "timestamp_sec", "client_id"],
};
let missing = 0;
for (const [table, cols] of Object.entries(want)) {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const have = new Set(info.rows.map((r) => String(r.name)));
  for (const c of cols) {
    if (!have.has(c)) {
      console.error(`  ⚠ ${table}.${c} がありません (ALTER TABLE が要ります)`);
      missing++;
    }
  }
}
console.log(
  missing === 0
    ? "\n列の確認: OK"
    : `\n列の確認: ${missing} 件不足。schema-streamers.sql 末尾の移行 SQL を流してください。`,
);
process.exit(missing === 0 ? 0 : 1);
