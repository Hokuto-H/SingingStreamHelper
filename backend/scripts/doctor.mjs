/**
 * 「どこが壊れているか」を切り分ける。
 *
 *   npm run dev      # 別のターミナルで起動しておく
 *   npm run doctor
 *
 * ─────────────────────────────────────────────────────────
 * smoke は「機能が動くか」を見るが、こちらは**手前の 3 つ**を見る。
 *
 *   1. .dev.vars に必要な値が入っているか
 *   2. Turso に必要なテーブルと**列**が揃っているか
 *   3. ルートが 1 本 1 本ちゃんと生えているか
 *
 * 3 が効く場面がある。Hono は登録されていないパスに
 * **プレーンテキストの "404 Not Found"** を返すので、
 * 「ルートが無い」と「ルートはあるが 404 を返した」を区別できる。
 * ファイルを手で写していて 1 ブロック抜けた、というときに一発で分かる。
 * ─────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { loadDevVars } from "./env.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
let problems = 0;

const mark = (good) => (good ? "  OK " : "  NG ");
function line(good, text, extra = "") {
  if (!good) problems++;
  console.log(`${mark(good)} ${text}${extra ? `  ${extra}` : ""}`);
}

// =====================================================================
// 1. .dev.vars
// =====================================================================

console.log("\n=== 1. .dev.vars ===");
const vars = loadDevVars();
const have = (k) => Boolean(process.env[k] ?? vars[k]);

line(have("TURSO_DATABASE_URL"), "TURSO_DATABASE_URL がある");
line(have("TURSO_AUTH_TOKEN"), "TURSO_AUTH_TOKEN がある");

const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? vars.GOOGLE_SERVICE_ACCOUNT_JSON ?? "";
if (!saRaw) {
  line(false, "GOOGLE_SERVICE_ACCOUNT_JSON がある", "(曲マスタだけ試すなら無くてよい)");
  problems--; // これは必須ではないので数えない
} else {
  let sa = null;
  try {
    sa = JSON.parse(saRaw);
  } catch (e) {
    line(false, "GOOGLE_SERVICE_ACCOUNT_JSON が JSON として読める", String(e?.message ?? e));
  }
  if (sa) {
    line(true, "GOOGLE_SERVICE_ACCOUNT_JSON が JSON として読める");
    line(Boolean(sa.client_email), "client_email がある", sa.client_email ?? "");
    const pk = String(sa.private_key ?? "");
    line(pk.startsWith("-----BEGIN"), "private_key の形が正しい");
    // ★ ここがいちばん多い事故。
    //   .dev.vars をダブルクォートで囲むと \n が本物の改行に展開されて、
    //   1 行の値として読めなくなる。
    line(
      pk.split("\n").length >= 3,
      "private_key に改行が復元されている",
      pk.split("\n").length < 3
        ? "★ npm run key:set -- <鍵.json> で書き直してください"
        : `${pk.split("\n").length} 行`,
    );
  }
}
// ── wrangler.jsonc 側の設定 ────────────────────────────────
//
// ★ ここが抜けていると env.PAIRING が undefined になり、
//   /pair/start が「ルートはあるのに 500」という分かりにくい落ち方をする。
//   設定ファイルなので doctor で見ておく価値がある。
try {
  const raw = readFileSync("wrangler.jsonc", "utf8")
    .replace(/^﻿/, "")
    .replace(/^\s*\/\/.*$/gm, ""); // 行コメントを落としてから JSON として読む
  const wr = JSON.parse(raw);
  const bindings = wr.durable_objects?.bindings ?? [];
  line(
    bindings.some((b) => b.name === "PAIRING" && b.class_name === "PairingDO"),
    "wrangler.jsonc に PAIRING の Durable Object binding がある",
    bindings.length ? bindings.map((b) => b.name).join(", ") : "★ durable_objects が無い",
  );
  const mig = wr.migrations ?? [];
  const sqliteClasses = mig.flatMap((m) => m.new_sqlite_classes ?? []);
  line(
    sqliteClasses.includes("PairingDO"),
    "migrations が new_sqlite_classes で PairingDO を作っている",
    // ★ 無料プランは SQLite バックエンドの DO しか使えない。
    //   new_classes と書いてあると本番デプロイでだけ落ちる。
    mig.flatMap((m) => m.new_classes ?? []).includes("PairingDO")
      ? "★ new_classes になっています。無料プランでは new_sqlite_classes が必要です"
      : "",
  );
} catch (e) {
  line(false, "wrangler.jsonc が読める", String(e?.message ?? e));
}

const sheet = process.env.SMOKE_SPREADSHEET ?? vars.SMOKE_SPREADSHEET ?? "";
console.log(
  `  --  SMOKE_SPREADSHEET: ${sheet ? sheet.slice(0, 60) : "(未設定 → smoke は曲マスタだけ)"}`,
);

// =====================================================================
// 2. Turso のテーブルと列
// =====================================================================

console.log("\n=== 2. Turso のスキーマ ===");

// ★ コードが実際に SELECT / INSERT する列を**全部**並べる。
//   ここが欠けていると「doctor は OK なのに 500 が出る」という
//   いちばん困る状態になる。
const WANT = {
  songs: [
    "id", "title", "reading_title", "artist",
    "title_key", "reading_key", "artist_key", "created_at",
  ],
  streamers: [
    "id", "spreadsheet_id", "repertoire_sheet", "history_sheet", "timezone",
    "spreadsheet_title", "title_synced_at", "display_name", "is_public",
    "created_at", "updated_at",
  ],
  streamer_tokens: [
    "token_hash", "streamer_id", "scope", "label",
    "created_at", "last_used_at", "revoked_at",
  ],
  performances: [
    "id", "streamer_id", "song_id", "sung_at",
    "stream_url", "timestamp_sec", "client_id", "synced_at", "created_at",
  ],
  recovery_challenges: ["spreadsheet_id", "code", "expires_at", "created_at"],
};

if (!have("TURSO_DATABASE_URL") || !have("TURSO_AUTH_TOKEN")) {
  console.log("  -- 接続情報が無いので飛ばします");
} else {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL ?? vars.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN ?? vars.TURSO_AUTH_TOKEN,
  });
  for (const [table, cols] of Object.entries(WANT)) {
    let info;
    try {
      info = await db.execute(`PRAGMA table_info(${table})`);
    } catch (e) {
      line(false, `テーブル ${table}`, String(e?.message ?? e));
      continue;
    }
    if (info.rows.length === 0) {
      line(false, `テーブル ${table} がある`, "★ npm run db:migrate を実行してください");
      continue;
    }
    const found = new Set(info.rows.map((r) => String(r.name)));
    const lack = cols.filter((c) => !found.has(c));
    line(
      lack.length === 0,
      `テーブル ${table} の列`,
      lack.length ? `★ 不足: ${lack.join(", ")}` : `${found.size} 列`,
    );
    if (lack.length) {
      console.log(
        `       → CREATE TABLE IF NOT EXISTS は**列を追加しません**。` +
          `\n         schema-streamers.sql 末尾の ALTER TABLE を流してください。`,
      );
    }
  }

  // ── アプリが実際に流すクエリを、行を読まずに試す ──────────
  //
  // ★ PRAGMA の列チェックだけでは「JOIN したときに壊れる」を拾えない。
  //   LIMIT 0 を付ければ 1 行も読まずに、列名の間違いだけを確かめられる
  //   (Turso は読んだ行数で課金されるので、これならタダ)。
  const PROBES = {
    "セッション解決 (resolveSession)": `
      SELECT s.id, s.spreadsheet_id, s.repertoire_sheet, s.history_sheet,
             s.timezone, s.spreadsheet_title, s.title_synced_at,
             s.display_name, s.is_public, s.created_at,
             t.scope, t.label, t.last_used_at
        FROM streamer_tokens t
        JOIN streamers s ON s.id = t.streamer_id
       WHERE t.token_hash = 'x' AND t.revoked_at IS NULL
       LIMIT 0`,
    "公開ページ (findPublicStreamer)": `
      SELECT id, display_name, spreadsheet_id, repertoire_sheet, history_sheet
        FROM streamers WHERE id = 'x' AND is_public = 1 LIMIT 0`,
    "未同期の控え (resync)": `
      SELECT p.id, p.song_id, p.sung_at, p.stream_url, p.timestamp_sec, s.title
        FROM performances p LEFT JOIN songs s ON s.id = p.song_id
       WHERE p.streamer_id = 'x' AND p.synced_at IS NULL LIMIT 0`,
    "曲の検索 (buildSearchQuery)": `
      SELECT id, title, reading_title, artist, created_at
        FROM songs WHERE reading_key >= 'ア' AND reading_key < 'イ' LIMIT 0`,
  };
  for (const [name, sql] of Object.entries(PROBES)) {
    try {
      await db.execute(sql);
      line(true, `クエリが通る: ${name}`);
    } catch (e) {
      line(false, `クエリが通る: ${name}`, `★ ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
}

// =====================================================================
// 3. ルートが生えているか
// =====================================================================

console.log("\n=== 3. ルート ===");
console.log("  (認証や入力の不備で 4xx が返るのは正常。見ているのは「生えているか」だけ)\n");

/** [メソッド, パス, 期待する状態] */
const ROUTES = [
  ["GET", "/songs?title=%E3%81%82"],
  ["POST", "/songs"],
  ["GET", "/songs/suggest?title=%E3%81%82"],
  ["POST", "/streamers"],
  ["POST", "/streamers/recover/start"],
  ["POST", "/streamers/recover/complete"],
  ["POST", "/auth/session"],
  ["GET", "/me"],
  ["PATCH", "/me"],
  ["GET", "/me/tokens"],
  ["POST", "/me/tokens"],
  ["POST", "/me/tokens/revoke-docks"],
  ["DELETE", "/me/tokens/deadbeef"],
  ["GET", "/me/repertoire"],
  ["POST", "/me/repertoire"],
  ["GET", "/me/performances"],
  ["POST", "/me/performances"],
  ["POST", "/me/resync"],
  ["GET", "/me/public-fields"],
  ["PUT", "/me/public-fields"],
  // ★ OBS ドックのペアリング。
  //   /pair/start だけは認証も入力も要らないので 201 が返る。
  //   ここが 500 になるなら、まず疑うのは wrangler.jsonc の
  //   durable_objects / migrations が抜けていること
  //   (env.PAIRING が undefined → "Cannot read properties of undefined")。
  ["POST", "/pair/start"],
  ["POST", "/pair/claim"],
  ["POST", "/pair/confirm"],
  ["POST", "/pair/status"],
  ["GET", "/public/streamers/01a00000-0000-7000-8000-000000000000"],
  ["GET", "/public/streamers/01a00000-0000-7000-8000-000000000000/repertoire"],
  ["GET", "/public/streamers/01a00000-0000-7000-8000-000000000000/history"],
];

let reachable = true;
for (const [method, path] of ROUTES) {
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      body: ["GET", "HEAD", "DELETE"].includes(method) ? undefined : "{}",
    });
    text = await res.text();
  } catch (e) {
    if (reachable) {
      console.error(
        `\n[接続できません] ${BASE} に届きませんでした。` +
          `\n  別のターミナルで npm run dev を動かしていますか？\n  ${e?.message ?? e}\n`,
      );
      reachable = false;
    }
    problems++;
    break;
  }

  // ★ Hono は未登録のパスに**プレーンテキストの "404 Not Found"** を返す。
  //   ルートが生えていれば、たとえ 404 でも JSON が返る。
  let isJson = true;
  try {
    JSON.parse(text);
  } catch {
    isJson = false;
  }
  const missing = res.status === 404 && !isJson;

  let note = `→ ${res.status}`;
  if (missing) note = "★ ルートが登録されていません";
  else if (res.status >= 500) {
    // DEBUG_ERRORS=1 なら例外の中身が入っている
    let detail = "";
    try {
      const j = JSON.parse(text);
      detail = j.message ? ` (${j.message})` : "";
    } catch { /* ignore */ }
    note = `★ ${res.status}${detail}`;
    problems++;
  }
  line(!missing && res.status < 500,
    `${method.padEnd(6)} ${path.replace(/01a00000-[0-9a-f-]+/, "<id>").padEnd(42)}`,
    note);
  if (!missing && res.status >= 500) problems--; // 上で数えたので二重に数えない
}

// =====================================================================

console.log(
  problems === 0
    ? "\n===== 問題は見つかりませんでした ====="
    : `\n===== ${problems} 件 気になる点があります =====`,
);
if (problems > 0) {
  console.log(
    "\n500 が出ている場合は、`npm run dev` を動かしているターミナルに" +
      "\n例外のスタックトレースがそのまま出ています。そこが一次情報です。" +
      "\n.dev.vars に DEBUG_ERRORS=1 を書くと、レスポンスにも中身が入ります。",
  );
}
process.exit(problems === 0 ? 0 : 1);
