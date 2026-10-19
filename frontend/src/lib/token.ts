import { TOKEN_KEY } from "./config";

/**
 * ドック用トークンの置き場所。
 *
 * ★ localStorage に置くのは**意図した選択**。
 *   OBS のカスタムブラウザドックはプロファイルごとに localStorage を
 *   保持するので、OBS を閉じても残る。毎回ペアリングし直さずに済む。
 *
 * ★ 代わりに、同じオリジンで動く JavaScript からは読める。
 *   このアプリは外部から文字列を流し込む口を持たない (URL も読まない) ので
 *   実害は無いが、**サードパーティのスクリプトを足さないこと**が前提になる。
 *   広告タグや解析タグを入れると、その時点でトークンを渡したのと同じになる。
 *
 * ★ 漏れたときのために、トークンは失効させられる:
 *     POST /me/tokens/revoke-docks
 */

let cached: string | null | undefined;

export function getToken(): string | null {
  if (cached !== undefined) return cached;
  try {
    cached = localStorage.getItem(TOKEN_KEY);
  } catch {
    cached = null;   // プライベートウィンドウなどで読めないことがある
  }
  return cached;
}

export function setToken(token: string | null): void {
  cached = token;
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 保存できなくても、この起動のあいだは cached で動く
  }
  listeners.forEach((f) => f(token));
}

const listeners = new Set<(t: string | null) => void>();

export function onTokenChange(f: (t: string | null) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
