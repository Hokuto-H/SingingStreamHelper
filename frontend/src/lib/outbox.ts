import { ApiError, api, newClientId } from "./api";
import { OUTBOX } from "./config";
import { onTokenChange } from "./token";
import type { PerformanceInput, RepertoireInput } from "./types";

// =====================================================================
// 送信キュー (outbox)
// =====================================================================
//
// ## なぜ要るか
//
// サーバ側にも outbox はあるが、あれが救えるのは
// **「サーバまでは届いたが Google Sheets への書き込みが失敗した」**場合だけ。
//
// 配信中に実際に起きるのはむしろ逆で、
// **配信者の回線が切れてサーバに届かなかった**ほうが多い。
// そのときブラウザ側に残していないと、歌った記録がそのまま消える。
// 歌枠は 2〜4 時間あり、その間に数十曲歌う。1 曲落ちても気づけない。
//
// ## 何を積んでよいか
//
//   積んでよい … **後から足しても意味が変わらないもの**
//                 POST /me/performances   (歌唱記録。History に 1 行足す)
//                 POST /me/repertoire     (持ち歌を足す)
//
//   積んではいけない … **「今の状態」を決めるもの**
//                 POST /me/now-playing    最新だけが正しい。古いのを後から
//                                         送ると、終わった曲が画面に戻る
//                 PUT  /me/queue          古い並びで上書きすると曲が消える
//                 POST /me/queue/next     押した時点でのキュー先頭に意味がある
//
// この線引きを間違えると、復旧したつもりで配信画面を壊す。
//
// ## 二重送信にならない理由
//
// 積むときに clientId を 1 回だけ作り、再送でも**同じものを送る**。
// サーバ側が clientId で弾くので、「届いていたのに応答が返らなかった」
// ケースで送り直しても記録は 1 行のまま。
// =====================================================================

export type OutboxEntry = {
  /** = clientId。再送しても変えない */
  id: string;
  method: string;
  path: string;
  body: unknown;
  createdAt: number;
  attempts: number;
  /** 次に試してよい時刻 */
  nextAt: number;
  lastError?: string;
  /** failed = 自動では送らない。人が見て再送するか捨てるか決める */
  state: "pending" | "failed";
  /** 画面に出すための説明 (「夜に駆ける の記録」など) */
  label: string;
};

export type OutboxStatus = {
  pending: number;
  failed: number;
  /** トークン失効で止まっている */
  pausedForPairing: boolean;
  sending: boolean;
  entries: OutboxEntry[];
};

// ── 読み書き ────────────────────────────────────────────

function load(): OutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX.KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as OutboxEntry[]) : [];
  } catch {
    // ★ 壊れていても捨てない方向に倒す……が、読めないものは直せない。
    //   空で続けるが、元の文字列は別キーに退避しておく。
    try {
      const raw = localStorage.getItem(OUTBOX.KEY);
      if (raw) localStorage.setItem(OUTBOX.KEY + ".broken." + Date.now(), raw);
    } catch { /* 退避もできないなら諦める */ }
    return [];
  }
}

function save(list: OutboxEntry[]): void {
  try {
    localStorage.setItem(OUTBOX.KEY, JSON.stringify(list));
  } catch {
    // ★ 容量超過。古い pending を failed に落として場所を作る。
    //   黙って消すと「送ったはずの記録が無い」になるので、消さずに残す。
    const trimmed = list.slice(-OUTBOX.MAX_ITEMS);
    try { localStorage.setItem(OUTBOX.KEY, JSON.stringify(trimmed)); } catch { /* 無理 */ }
  }
}

// ── 購読 ────────────────────────────────────────────────

const listeners = new Set<(s: OutboxStatus) => void>();
let pausedForPairing = false;
let sending = false;

export function subscribe(f: (s: OutboxStatus) => void): () => void {
  listeners.add(f);
  f(status());
  return () => listeners.delete(f);
}

function emit() {
  const s = status();
  listeners.forEach((f) => f(s));
}

export function status(): OutboxStatus {
  const entries = load();
  return {
    entries,
    pending: entries.filter((e) => e.state === "pending").length,
    failed: entries.filter((e) => e.state === "failed").length,
    pausedForPairing,
    sending,
  };
}

// ── 積む ────────────────────────────────────────────────

function push(method: string, path: string, body: unknown, label: string, id: string) {
  const list = load();
  // ★ 同じ clientId が既にあるなら積み直さない (連打対策)
  if (list.some((e) => e.id === id)) return id;

  list.push({
    id, method, path, body, label,
    createdAt: Date.now(),
    attempts: 0,
    nextAt: 0,
    state: "pending",
  });
  if (list.length > OUTBOX.MAX_ITEMS) {
    // 古いものから「要確認」に落とす。消さない。
    for (let i = 0; i < list.length - OUTBOX.MAX_ITEMS; i++) {
      list[i].state = "failed";
      list[i].lastError = "溜まりすぎたので自動送信を止めました";
    }
  }
  save(list);
  emit();
  void flush();
  return id;
}

/** 歌唱記録を積む。**clientId は呼び出し側で作って渡してもよい**（連打対策） */
export function enqueuePerformance(p: Omit<PerformanceInput, "clientId"> & { clientId?: string }) {
  const clientId = p.clientId ?? newClientId();
  const label = `${p.title ?? "(曲名なし)"} の記録`;
  return push("POST", "/me/performances", [{ ...p, clientId }], label, clientId);
}

/** 持ち歌の追加を積む */
export function enqueueRepertoire(r: RepertoireInput) {
  const clientId = newClientId();
  return push("POST", "/me/repertoire", r, `${r.title} を持ち歌に追加`, clientId);
}

// ── 送る ────────────────────────────────────────────────

function backoff(attempts: number): number {
  const d = OUTBOX.BASE_DELAY_MS * 2 ** attempts;
  // ★ 全員が同じ秒数で再送しないように少し散らす
  return Math.min(OUTBOX.MAX_DELAY_MS, d) * (0.75 + Math.random() * 0.5);
}

let flushing: Promise<void> | null = null;

export function flush(): Promise<void> {
  // ★ 多重起動を防ぐ。online と interval とユーザー操作が同時に来る
  if (flushing) return flushing;
  flushing = run().finally(() => { flushing = null; });
  return flushing;
}

async function run(): Promise<void> {
  if (pausedForPairing) return;

  sending = true;
  emit();
  try {
    // ★ 1 件ずつ、古い順に。History の行順が入れ替わらないようにする。
    //   並列に投げると速いが、順序が崩れて後から読む人が困る。
    for (;;) {
      const list = load();
      const now = Date.now();
      const i = list.findIndex((e) => e.state === "pending" && e.nextAt <= now);
      if (i < 0) break;

      const entry = list[i];
      try {
        await api(entry.path, { method: entry.method, body: entry.body });
        // 成功。消す。
        const after = load().filter((e) => e.id !== entry.id);
        save(after);
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(String(e), 0, null, true);
        const after = load();
        const j = after.findIndex((x) => x.id === entry.id);
        if (j < 0) break;   // 別タブが片付けた

        if (err.needsPairing) {
          // ★ 捨てない。トークンが切れただけで中身は正しい。
          //   キュー全体を止めて、再ペアリングを促す。
          pausedForPairing = true;
          after[j].lastError = "ペアリングが切れています";
          save(after);
          break;
        }

        after[j].attempts += 1;
        after[j].lastError = err.message;

        if (!err.retryable || after[j].attempts >= OUTBOX.MAX_ATTEMPTS) {
          // ★ 4xx は何度送っても同じ。ここで止めて人に見せる。
          //   **先頭で詰まらせない**ので、後ろの記録は送られる。
          after[j].state = "failed";
          save(after);
          continue;
        }

        after[j].nextAt = Date.now() + backoff(after[j].attempts);
        save(after);
        // ★ 届かなかったのなら、次の 1 件も届かない。この回は打ち切る。
        if (err.offline) break;
      }
    }
  } finally {
    sending = false;
    emit();
  }
}

// ── 人が触る口 ──────────────────────────────────────────

/**
 * バックオフを無視して**すぐ**送り直す。
 *
 * ★ 回線が戻った瞬間と、人が「いま送る」を押したときに要る。
 *   flush() だけだと、直前の失敗で入った待ち時間 (最大 60 秒) が
 *   残ったままなので**何も起きないように見える**。
 *   回線が復帰したという情報は待ち時間より確かなので、上書きしてよい。
 *
 *   attempts は減らさない。上限 (MAX_ATTEMPTS) は効かせ続ける。
 */
export function kick(): void {
  const list = load();
  let changed = false;
  for (const e of list) {
    if (e.state === "pending" && e.nextAt !== 0) { e.nextAt = 0; changed = true; }
  }
  if (changed) { save(list); emit(); }
  void flush();
}

/** 「要確認」をもう一度送る */
export function retryFailed(): void {
  const list = load().map((e) =>
    e.state === "failed" ? { ...e, state: "pending" as const, attempts: 0, nextAt: 0 } : e);
  save(list);
  emit();
  void flush();
}

/** 1 件捨てる。**人が明示的に押したときだけ** */
export function drop(id: string): void {
  save(load().filter((e) => e.id !== id));
  emit();
}

/** 再ペアリングが済んだら呼ぶ */
export function resume(): void {
  pausedForPairing = false;
  const list = load().map((e) => ({ ...e, nextAt: 0 }));
  save(list);
  emit();
  void flush();
}

// ── 起動 ────────────────────────────────────────────────

let started = false;

export function startOutbox(): () => void {
  if (started) return () => {};
  started = true;

  const tick = setInterval(() => { void flush(); }, OUTBOX.TICK_MS);
  const onOnline = () => { kick(); };   // ★ 待ち時間を無視して即送る
  const onVisible = () => { if (!document.hidden) void flush(); };
  // ★ 別タブ / 別ドックが積んだものにも気づく
  const onStorage = (e: StorageEvent) => { if (e.key === OUTBOX.KEY) emit(); };
  const offToken = onTokenChange((t) => { if (t) resume(); });

  addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("storage", onStorage);
  void flush();

  return () => {
    clearInterval(tick);
    removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    removeEventListener("storage", onStorage);
    offToken();
    started = false;
  };
}
