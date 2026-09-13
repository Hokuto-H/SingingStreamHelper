/**
 * サービスアカウントの JSON キーを .dev.vars に書き込む。
 *
 *   npm run key:set -- ./sa-key.json
 *
 * ─────────────────────────────────────────────────────────
 * ## なぜスクリプトにするのか
 *
 * この 1 行はシェルの引用符の地雷原になっている。
 *
 *   ・`private_key` の中の `\n` は **「バックスラッシュ + n」のまま**
 *     でなければならない。改行に展開されると鍵として読めなくなる。
 *   ・PowerShell の `>>` は Windows PowerShell 5.1 だと **UTF-16 で書く**。
 *     そのまま追記すると .dev.vars 全体が読めなくなる。
 *   ・bash と PowerShell と cmd で引用符の扱いが全部違う。
 *
 * Node に書かせれば、どの OS のどのシェルから呼んでも同じ結果になる。
 * ─────────────────────────────────────────────────────────
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("使い方: npm run key:set -- <サービスアカウントのJSONキーのパス>");
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`ファイルが見つかりません: ${keyPath}`);
  process.exit(1);
}

let sa;
try {
  sa = JSON.parse(readFileSync(keyPath, "utf8").replace(/^/, ""));
} catch (e) {
  console.error(`JSON として読めません: ${e?.message ?? e}`);
  process.exit(1);
}
if (!sa.client_email || !sa.private_key) {
  console.error("client_email / private_key がありません。サービスアカウントの鍵ですか？");
  process.exit(1);
}

const TARGET = ".dev.vars";
const LINE = `GOOGLE_SERVICE_ACCOUNT_JSON='${JSON.stringify(sa)}'`;

const before = existsSync(TARGET)
  ? readFileSync(TARGET, "utf8").replace(/^/, "")
  : "";
// 既に同じキーの行があれば置き換える
const kept = before
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith("GOOGLE_SERVICE_ACCOUNT_JSON="));
const out = [...kept.filter((l, i, a) => !(l === "" && i === a.length - 1)), LINE, ""].join("\n");

// ★ BOM 無しの UTF-8 / LF で書く
writeFileSync(TARGET, out, { encoding: "utf8" });

console.log(`${TARGET} に書き込みました。`);
console.log(`  共有先のアドレス: ${sa.client_email}`);
console.log(`  ★ テスト用のスプレッドシートを、このアドレスに「編集者」で共有してください。`);
