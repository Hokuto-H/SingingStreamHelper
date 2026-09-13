/**
 * 同期済みの控え (performances) を掃除する。
 *
 *   npm run db:purge            # 24 時間より古いものを消す
 *   npm run db:purge -- --all   # 同期済みなら全部消す
 *
 * ─────────────────────────────────────────────────────────
 * 本番では cron (wrangler.jsonc の triggers) が毎日やる。
 * ただし **wrangler dev では cron は自動で動かない**ので、
 * ローカルで試していると控えが溜まっていく。手で流すためのもの。
 *
 * performances は「Sheets に書けるまでの outbox」であって
 * 歌唱履歴の保管場所ではない (正本はスプレッドシート)。
 * synced_at が入っている行はもう役目を終えている。
 * ─────────────────────────────────────────────────────────
 */
import { createClient } from "@libsql/client";
import { env } from "./env.mjs";

const all = process.argv.includes("--all");
const cutoff = all ? Date.now() : Date.now() - 24 * 60 * 60 * 1000;

const db = createClient({
  url: env("TURSO_DATABASE_URL"),
  authToken: env("TURSO_AUTH_TOKEN"),
});

const before = await db.execute(
  `SELECT
     count(*) AS total,
     sum(CASE WHEN synced_at IS NULL THEN 1 ELSE 0 END) AS unsynced
   FROM performances`,
);
const t = Number(before.rows[0].total ?? 0);
const u = Number(before.rows[0].unsynced ?? 0);
console.log(`いまの控え: ${t} 行 (うち未同期 ${u} 行)`);

const rs = await db.execute({
  sql: `DELETE FROM performances
         WHERE synced_at IS NOT NULL AND synced_at < ?
     RETURNING id`,
  args: [cutoff],
});
console.log(`${rs.rows.length} 行を消しました${all ? " (--all)" : " (24時間より古いもの)"}`);

const after = await db.execute(`SELECT count(*) AS n FROM performances`);
console.log(`残り: ${after.rows[0].n} 行`);
if (u > 0) {
  console.log(
    `\n★ 未同期が ${u} 行あります。これは消していません。` +
      `\n  POST /me/resync で Sheets に送り直せます。`,
  );
}
