import { API_BASE } from "./config";
import { getToken } from "./token";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** ネットワーク層で届かなかった (= サーバは何も知らない) */
  readonly offline: boolean;

  constructor(message: string, status: number, body: unknown, offline = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.offline = offline;
  }

  /**
   * ★ 「もう一度送って意味があるか」。送信キューの要。
   *
   *   - 届かなかった / 5xx / 429 → 送り直す価値がある
   *   - 4xx → こちらの出し方が悪いので、何度送っても同じ。**積み続けない**
   *   - 401 だけは別扱い。トークンが失効しただけで、中身は正しい。
   *     捨てると歌唱記録が消えるので、キューを止めて再ペアリングを促す。
   */
  get retryable(): boolean {
    if (this.offline) return true;
    if (this.status === 429) return true;
    return this.status >= 500;
  }

  get needsPairing(): boolean {
    return this.status === 401;
  }
}

type Options = {
  method?: string;
  body?: unknown;
  /** 認証を付けない (/health や /pair/start など) */
  anonymous?: boolean;
  signal?: AbortSignal;
};

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = {};

  if (!opts.anonymous) {
    const token = getToken();
    // ★ トークンが無いまま叩くと 401 が返る。それ自体は正しいが、
    //   「まだペアリングしていない」と「失効した」が区別できなくなる。
    //   ここで止めて、呼び出し側に理由を渡す。
    if (!token) throw new ApiError("ペアリングがまだです", 401, null);
    headers.authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      // ★ Cookie は使わない。認証は Authorization ヘッダだけ。
      //   credentials を付けると CORS の条件が一段厳しくなり、
      //   得るものが無いのに事故の種が増える。
      credentials: "omit",
    });
  } catch (e) {
    // ★ ここに来るのは「サーバに届かなかった」場合。
    //   CORS で弾かれた場合も区別なくここに来るので、
    //   開発中に「オフライン扱いで延々と再送」になったら CORS を疑うこと。
    throw new ApiError(
      e instanceof Error ? e.message : "サーバに届きませんでした",
      0, null, true,
    );
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new ApiError(`${method} ${path} が ${res.status}: ${detail}`, res.status, body);
  }
  return body as T;
}

/** 冪等キー。**積むときに 1 回だけ作り、再送では作り直さない。** */
export function newClientId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `dock-${Date.now()}-${rand}`;
}
