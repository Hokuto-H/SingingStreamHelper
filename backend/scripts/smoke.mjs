/**
 * 起動中のサーバに実際に HTTP を投げて、ひととおり動くか確かめる。
 *
 *   npm run dev          # 別のターミナルで起動しておく
 *   npm run smoke        # こちらを実行
 *
 * ─────────────────────────────────────────────────────────
 * ## 2 段階に分かれている
 *
 *   第 1 段: 曲マスタだけ (Google の設定が要らない)
 *   第 2 段: 配信者まわり (サービスアカウントとスプレッドシートが要る)
 *
 * `SMOKE_SPREADSHEET` が無ければ第 1 段だけ走る。
 * まず第 1 段を通してから Google の設定に進むと、
 * 「どっちが原因か分からない」状態を避けられる。
 *
 * ## 2 回目以降も流せる
 *
 * 発行したトークンを `.smoke-token` に保存して使い回す。
 * (同じスプレッドシートの 2 回目の登録は 409 になるのが正しい挙動なので、
 *  毎回新規登録しようとすると 2 回目から失敗してしまう。)
 * ─────────────────────────────────────────────────────────
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "./env.mjs";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:8787";
const SPREADSHEET = process.env.SMOKE_SPREADSHEET ?? env("SMOKE_SPREADSHEET", { required: false });
const TOKEN_FILE = ".smoke-token";

const ok = [];
const ng = [];
function check(name, cond, extra = "") {
  (cond ? ok : ng).push(name);
  const mark = cond ? "  OK " : "  NG ";
  console.log(`${mark} ${name}${extra ? `  ${extra}` : ""}`);
}
function section(t) {
  console.log(`\n=== ${t} ===`);
}
const short = (v) => JSON.stringify(v ?? null).slice(0, 200);

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    console.error(
      `\n[接続できません] ${BASE} に届きませんでした。` +
        `\n  別のターミナルで npm run dev を動かしていますか？` +
        `\n  ${e?.message ?? e}\n`,
    );
    process.exit(1);
  }
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 300) };
  }
  return { status: res.status, body: json };
}

// =====================================================================
// 第 1 段: 曲マスタ (Google 不要)
// =====================================================================

section("1. 曲マスタ");

const stamp = Date.now();
let r = await call("POST", "/songs", {
  body: [
    { title: `テスト曲${stamp}`, readingTitle: "てすときょく", artist: "テスト歌手" },
    { title: `夜に駆ける${stamp}`, readingTitle: "よるにかける", artist: "YOASOBI" },
  ],
});
check("POST /songs で登録できる", r.status === 201 || r.status === 200, `status=${r.status} ${short(r.body)}`);
const songId = r.body?.created?.[0]?.id;
check("曲 ID が返る", typeof songId === "string" && songId.length > 0, String(songId));

r = await call("GET", `/songs?title=${encodeURIComponent("てすと")}`);
check("GET /songs (仮名) で引ける", r.status === 200 && (r.body?.items?.length ?? 0) > 0,
  `status=${r.status} items=${r.body?.items?.length}`);

r = await call("GET", `/songs?title=${encodeURIComponent("夜")}`);
check("GET /songs (漢字) で引ける", r.status === 200 && (r.body?.items?.length ?? 0) > 0,
  `items=${r.body?.items?.length}`);

r = await call("GET", `/songs?artist=${encodeURIComponent("YOASOBI")}`);
check("GET /songs (アーティスト) で引ける", r.status === 200 && (r.body?.items?.length ?? 0) > 0,
  `items=${r.body?.items?.length}`);

r = await call("POST", "/songs", { body: [{ title: "", readingTitle: "", artist: "" }] });
check("空文字は 400 で弾かれる", r.status === 400, `status=${r.status}`);

r = await call("GET", "/songs");
check("検索条件なしは 400", r.status === 400, `status=${r.status}`);

// 200 件の窓の外のページは、そもそもリクエストとして受け付けない (zod で 400)。
// 「窓の中だが続きがある」ときは 200 + refine:true が返る (件数が要るのでここでは試さない)。
r = await call("GET", `/songs?title=${encodeURIComponent("て")}&limit=200&page=99`);
check("200 件の窓の外のページは 400", r.status === 400, short(r.body).slice(0, 110));

r = await call("GET", `/songs?title=${encodeURIComponent("て")}&limit=50`);
check("窓の中なら refine フラグ付きで 200", r.status === 200 && typeof r.body?.refine === "boolean",
  `refine=${r.body?.refine}`);

if (!SPREADSHEET) {
  console.log(
    "\nSMOKE_SPREADSHEET が未設定なので、配信者まわりは飛ばします。" +
      "\n  .dev.vars に SMOKE_SPREADSHEET=<スプレッドシートのURLかID> を足すと第 2 段も走ります。",
  );
  finish();
}

// =====================================================================
// 第 2 段: 配信者 (サービスアカウント + スプレッドシートが要る)
// =====================================================================

section("2. 登録とログイン");

let token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";

if (token) {
  r = await call("GET", "/me", { token });
  if (r.status !== 200) {
    console.log("  (保存済みトークンが無効でした。登録し直します)");
    token = "";
  } else {
    check("保存済みトークンでログインできる", true, `id=${r.body?.streamer?.id}`);
  }
}

if (!token) {
  r = await call("POST", "/streamers", {
    body: { spreadsheet: SPREADSHEET, displayName: "スモークテスト" },
  });
  if (r.status === 403) {
    console.error(
      `\n[共有ができていません] スプレッドシートを次のアドレスに` +
        `「編集者」で共有してください:\n  ${r.body?.shareWith}\n`,
    );
    process.exit(1);
  }
  if (r.status === 409) {
    console.error(
      "\n[登録済み] このスプレッドシートは既に登録されています。" +
        "\n  .smoke-token にトークンを書くか、復旧手続き" +
        " (POST /streamers/recover/start) を使ってください。\n",
    );
    process.exit(1);
  }
  check("POST /streamers で登録できる", r.status === 201, `status=${r.status} ${short(r.body)}`);
  token = r.body?.token ?? "";
  if (token) writeFileSync(TOKEN_FILE, token);
  check("平文トークンが 1 回だけ返る", token.startsWith("sst_"));
  check("scope は full", r.body?.scope === "full");
}

r = await call("POST", "/auth/session", { body: { token } });
check("POST /auth/session が通る", r.status === 200, `status=${r.status}`);
const me = r.body?.streamer;
const streamerId = me?.id;
check("スプレッドシート ID が返る", typeof me?.spreadsheetId === "string", me?.spreadsheetId);
check("スプレッドシート URL が正しく組み立てられる",
  me?.spreadsheetUrl === `https://docs.google.com/spreadsheets/d/${me?.spreadsheetId}/edit`,
  me?.spreadsheetUrl);
check("タブ名が 2 枚返る", me?.repertoireSheet && me?.historySheet,
  `${me?.repertoireSheet} / ${me?.historySheet}`);
check("タイムゾーンが返る", typeof me?.timezone === "string", me?.timezone);
check("既定は非公開", me?.isPublic === false, String(me?.isPublic));

r = await call("POST", "/auth/session", { body: { token: "sst_" + "A".repeat(43) } });
check("知らないトークンは 401", r.status === 401, `status=${r.status}`);
r = await call("GET", "/me");
check("トークン無しは 401", r.status === 401, `status=${r.status}`);

section("3. 持ち歌 (Repertoire)");

r = await call("POST", "/me/repertoire", {
  token,
  body: [{
    songId, title: `テスト曲${stamp}`, artist: "テスト歌手",
    key: "+2", sourceUrl: "https://example.com/src",
    lyricsUrl: "https://example.com/lyrics", status: "◎",
    tags: "スモーク", notes: "ここは視聴者に見せない",
  }],
});
check("持ち歌を追加できる", r.status === 201 || r.status === 200, `status=${r.status} ${short(r.body)}`);

r = await call("GET", "/me/repertoire", { token });
check("持ち歌を読める", r.status === 200 && (r.body?.items?.length ?? 0) > 0,
  `items=${r.body?.items?.length}`);
const mine = r.body?.items?.find((x) => x.songId === songId);
check("本人には音源URLが見える", mine?.sourceUrl === "https://example.com/src", mine?.sourceUrl);
check("本人にはメモが見える", mine?.notes === "ここは視聴者に見せない");
// ★ Sheets は "+2" を数式として解釈してしまう。書き方を間違えると
//   符号が消えて "2" になる (キー設定にとっては致命的)。
check('★キー設定 "+2" が数値に化けていない', mine?.key === "+2", JSON.stringify(mine?.key));

// 数式と誤解される文字列が壊れないか (=LOVE は実在するグループ名)
r = await call("POST", "/me/repertoire", {
  token,
  body: [{ songId: `formula-${stamp}`, title: "=LOVE", artist: "-1", key: "+2", tags: "@home" }],
});
if (r.status === 201 || r.status === 200) {
  r = await call("GET", "/me/repertoire", { token });
  const f = r.body?.items?.find((x) => x.songId === `formula-${stamp}`);
  check('★"=LOVE" が数式として解釈されていない', f?.title === "=LOVE", JSON.stringify(f?.title));
  check('★"-1" も "@home" も残っている',
    f?.artist === "-1" && f?.tags === "@home", JSON.stringify([f?.artist, f?.tags]));
}

section("4. 歌唱記録 (History)");

const clientId = `smoke-${stamp}`;
r = await call("POST", "/me/performances", {
  token,
  body: {
    songId, clientId,
    streamUrl: "https://www.youtube.com/watch?v=smoke123",
    timestampSec: 123,
  },
});
check("歌唱を記録できる", r.status === 201 && r.body?.created?.length === 1, short(r.body));
check("Sheets に書けている (synced)", r.body?.synced === true,
  r.body?.synced === false ? "★false なら Google 側を確認 (共有・API 有効化)" : "");

r = await call("POST", "/me/performances", {
  token, body: { songId, clientId, streamUrl: "https://youtu.be/smoke123", timestampSec: 123 },
});
// レスポンスのキー名は duplicated。古い版は skipped だったので、どちらでも通す。
const dup = r.body?.duplicated ?? r.body?.skipped;
check("同じ clientId の再送は弾かれる",
  r.body?.created?.length === 0 && dup?.length === 1, short(r.body));
if (r.body?.duplicated === undefined && r.body?.skipped !== undefined) {
  console.log("       (参考: レスポンスのキーが skipped のままです。" +
    "duplicated に直すと「同じ曲を飛ばした」との混同が減ります)");
}

r = await call("POST", "/me/performances", { token, body: { songId } });
check("★同じ曲をもう一度歌える (アンコール)", r.body?.created?.length === 1, short(r.body));

r = await call("GET", "/me/performances?limit=10", { token });
check("履歴を読める", r.status === 200 && (r.body?.items?.length ?? 0) > 0,
  `items=${r.body?.items?.length}`);

// ★ Repertoire の K 列 (最終歌唱日) が日付の形で出ているか。
//   TEXT() で包んでいないと 46279.00299768519 のようなシリアル値になる。
{
  const rep2 = await call("GET", "/me/repertoire", { token });
  const it = rep2.body?.items?.find((x) => x.songId === songId);
  const last = it?.lastSungAt ?? "";
  check("★最終歌唱日が日付の形で出ている",
    last === "" || /^\d{4}-\d{2}-\d{2}/.test(String(last)),
    JSON.stringify(last) + (/^\d+(\.\d+)?$/.test(String(last))
      ? "  ★シリアル値のままです。K1 の数式を TEXT() 版に貼り替えてください" : ""));
  check("累計回数が数えられている", typeof it?.singCount === "number", String(it?.singCount));
}
check("未同期は残っていない", (r.body?.pending?.length ?? 0) === 0,
  `pending=${r.body?.pending?.length}`);
const h = r.body?.items?.find((x) => x.streamUrl);
check("タイムスタンプ付きリンクが組み立てられる",
  !h || h.watchUrl.includes("t="), h?.watchUrl);

section("5. 公開設定");

r = await call("GET", "/me/public-fields", { token });
check("公開設定を読める", r.status === 200, `status=${r.status}`);
check("既定で songId は非公開", r.body?.fields?.["repertoire.songId"] === false);
check("既定で notes は非公開", r.body?.fields?.["repertoire.notes"] === false);

r = await call("PUT", "/me/public-fields", { token, body: { "repertoire.key": false } });
check("公開設定を変えられる", r.status === 200 && r.body?.fields?.["repertoire.key"] === false,
  short(r.body?.fields));

r = await call("PUT", "/me/public-fields", { token, body: { "repertoire.sourceUrl": true } });
check("固定項目は変えられない (400)", r.status === 400, `status=${r.status}`);

section("6. 公開ページ");

r = await call("GET", `/public/streamers/${streamerId}/repertoire`);
check("非公開のうちは 404", r.status === 404, `status=${r.status}`);

r = await call("PATCH", "/me", { token, body: { isPublic: true } });
check("公開に切り替えられる", r.status === 200 && r.body?.streamer?.isPublic === true);

r = await call("GET", `/public/streamers/${streamerId}/repertoire`);
check("公開後は 200", r.status === 200, `status=${r.status}`);
const pub = r.body?.items?.[0] ?? {};
check("曲名・歌手は見える", "title" in pub && "artist" in pub, Object.keys(pub).join(","));
check("★音源URLは見えない", !("sourceUrl" in pub));
check("★歌詞URLは見えない", !("lyricsUrl" in pub));
check("★メモは見えない", !("notes" in pub));
check("★設定どおりキー設定が消えている", !("key" in pub));
check("★スプレッドシートIDが漏れていない",
  !JSON.stringify(r.body).includes(me?.spreadsheetId ?? "@@@"));

r = await call("GET", `/public/streamers/${streamerId}/history?limit=5`);
check("公開の歌唱履歴が読める", r.status === 200 && Array.isArray(r.body?.items),
  `items=${r.body?.items?.length}`);

r = await call("GET", "/public/streamers/01a00000-0000-7000-8000-000000000000/repertoire");
check("知らない ID は 404", r.status === 404, `status=${r.status}`);

// 後片付け: 公開設定を元に戻す
await call("PUT", "/me/public-fields", { token, body: { "repertoire.key": true } });
await call("PATCH", "/me", { token, body: { isPublic: false } });
console.log("\n(後片付け: 非公開に戻し、キー設定の公開を元に戻しました)");

// =====================================================================
// 第 5 段: OBS ドックのペアリング
// =====================================================================
//
// ここで確かめたいのは「繋がるか」より**「他人に渡らないか」**。
//
//   ① handle …… 誰がトークンを**受け取れる**か
//                 配信画面に映った code を見ただけの第三者は受け取り側になれない
//   ② pin ……… 誰のトークンが**流し込まれる**か
//                 code を打った他人がいても、配信者の手元のドックに
//                 その人の pin は入力されない
//
// 片方だけでは守れない。両方が効いていることを 1 本ずつ見る。
// (Durable Object を使うので、ローカルでも wrangler dev が
//  miniflare の DO を立ち上げる。追加の準備は要らない。)

section("5. OBS ドックのペアリング");

r = await call("POST", "/pair/start");
check("POST /pair/start (認証なし) が 201", r.status === 201, short(r.body));
if (r.status === 500) {
  console.log(
    "       → wrangler.jsonc の durable_objects / migrations が" +
      "\n         抜けていないか確かめてください (npm run doctor が見ます)。",
  );
}
const pairCode = r.body?.code;
const pairHandle = r.body?.handle;
check("code は XXXX-XXXX の 8 文字", /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(pairCode ?? ""), pairCode);
check("handle が返る (★画面には出さない値)",
  typeof pairHandle === "string" && pairHandle.length >= 40,
  pairHandle ? `${pairHandle.length} 文字` : "なし");

// ── claim にはログインが要る ──────────────────────────
r = await call("POST", "/pair/claim", { body: { code: pairCode } });
check("トークン無しの claim は 401", r.status === 401, `status=${r.status}`);

// ドック用トークンで claim できてしまうと、ドック 1 枚から
// 何枚でもドックトークンを生やせてしまう
const dockOnly = await call("POST", "/me/tokens", {
  token,
  body: { scope: "dock", label: `smoke-dock-${stamp}` },
});
r = await call("POST", "/pair/claim", {
  token: dockOnly.body?.token,
  body: { code: pairCode },
});
check("★dock トークンでの claim は 403 (増殖できない)", r.status === 403, `status=${r.status}`);

// ── 正しい流れ ─────────────────────────────────────
r = await call("POST", "/pair/claim", { token, body: { code: pairCode } });
check("配信者 (full) の claim が 200", r.status === 200, short(r.body));
const pairPin = r.body?.pin;
check("確認番号は 3 桁", /^\d{3}$/.test(pairPin ?? ""), pairPin);

// ── ①handle の向き ────────────────────────────────
r = await call("POST", "/pair/confirm", {
  body: { code: pairCode, handle: "A".repeat(43), pin: pairPin },
});
check("★code と pin を知っていても handle が違えば 403", r.status === 403, `status=${r.status}`);

// ── ②pin の向き ───────────────────────────────────
const wrongPin = String((Number(pairPin) + 1) % 1000).padStart(3, "0");
r = await call("POST", "/pair/confirm", {
  body: { code: pairCode, handle: pairHandle, pin: wrongPin },
});
check("★handle を持っていても pin が違えば 403", r.status === 403, `status=${r.status}`);
check("残り回数が返る", r.body?.remaining === 2, short(r.body));

// ── 大文字小文字とハイフンの揺れ ──────────────────────
r = await call("POST", "/pair/status", {
  body: { code: pairCode.replace("-", "").toLowerCase(), handle: pairHandle },
});
check("小文字・ハイフン無しでも同じコードとして届く", r.status === 200, short(r.body));
check("status は件数と期限だけ (誰かは返さない)",
  r.body?.claims === 1 && !short(r.body).includes("streamerId") && !short(r.body).includes("pin"),
  short(r.body));

// ── 成功 ───────────────────────────────────────────
r = await call("POST", "/pair/confirm", {
  body: { code: pairCode, handle: pairHandle, pin: pairPin },
});
check("正しい handle + pin で 201", r.status === 201, short(r.body));
const pairedToken = r.body?.token;
check("dock スコープで出る", r.body?.scope === "dock", r.body?.scope);

r = await call("GET", "/me", { token: pairedToken });
check("★出たトークンが配信者本人のものである",
  r.status === 200 && r.body?.streamer?.id === streamerId,
  `status=${r.status} id=…${String(r.body?.streamer?.id).slice(-8)} 期待=…${String(streamerId).slice(-8)}`);
check("ドックなので設定変更はできない",
  (await call("PATCH", "/me", { token: pairedToken, body: { displayName: "x" } })).status === 403);

// ── 単回使用 ───────────────────────────────────────
r = await call("POST", "/pair/confirm", {
  body: { code: pairCode, handle: pairHandle, pin: pairPin },
});
check("★同じ code は二度使えない", r.status === 404, `status=${r.status}`);

// ── 入力チェック ───────────────────────────────────
r = await call("POST", "/pair/claim", { token, body: { code: "ABC" } });
check("短すぎる code は 400", r.status === 400, `status=${r.status}`);
r = await call("POST", "/pair/claim", { token, body: { code: "ZZZZ-ZZZZ" } });
check("知らない code は 404", r.status === 404, `status=${r.status}`);

// 後片付け: ペアリングで出たトークンと、上で作った dock トークンを失効させる
await call("POST", "/me/tokens/revoke-docks", { token });
console.log("\n(後片付け: ペアリングで発行したドック用トークンを失効させました)");

finish();

function finish() {
  console.log(`\n===== ${ok.length} OK / ${ng.length} NG =====`);
  if (ng.length) {
    for (const n of ng) console.log(`  NG: ${n}`);
    process.exit(1);
  }
  process.exit(0);
}
