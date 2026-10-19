/**
 * 環境ごとに変わる値はここだけ。
 *
 * ★ Vite は VITE_ で始まる変数しかクライアントに渡さない。
 *   これは安全装置で、間違って秘密を混ぜても出ていかない……**わけではない**。
 *   VITE_ を付けたものは**ビルド成果物に文字列として埋め込まれる**ので、
 *   開発者ツールで誰でも読める。ここに秘密を書かないこと。
 */
export const API_BASE = (
  import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8787"
).replace(/\/+$/, "");   // 末尾の / を落とす。付いていると //me/queue になる

/** 送信キューの設定 */
export const OUTBOX = {
  /** localStorage のキー */
  KEY: "ssh.outbox.v1",
  /** 何回失敗したら「要確認」に落とすか */
  MAX_ATTEMPTS: 8,
  /** 溜めておく上限。超えたら古いものから「要確認」へ */
  MAX_ITEMS: 500,
  /** 再送の間隔 (ミリ秒)。指数バックオフの元 */
  BASE_DELAY_MS: 1000,
  /** 再送の間隔の上限 */
  MAX_DELAY_MS: 60_000,
  /** 定期的に様子を見る間隔 */
  TICK_MS: 5_000,
} as const;

export const TOKEN_KEY = "ssh.token.v1";
