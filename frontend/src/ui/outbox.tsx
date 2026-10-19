import { useEffect, useState } from "react";
import {
  type OutboxStatus, drop, enqueuePerformance, kick, retryFailed, status, subscribe,
} from "../lib/outbox";

/**
 * 送信キューの様子。
 *
 * ★ 見えるようにしておくこと自体が機能。
 *   配信者が知りたいのは「いま記録が溜まっているか」であって、
 *   黙って裏で再送していると「ちゃんと残っているのか」が分からない。
 *   配信が終わった後に 1 曲足りないと気づいても、もう直せない。
 */
export function Outbox() {
  const [s, setS] = useState<OutboxStatus>(status);
  useEffect(() => subscribe(setS), []);

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-bold tracking-wide text-neutral-400">④ 送信キュー</h2>
        <div className="flex items-center gap-2 text-xs">
          {s.sending && <span className="text-sky-400">送信中…</span>}
          <span className={s.pending ? "text-amber-300" : "text-neutral-500"}>
            待ち {s.pending}
          </span>
          <span className={s.failed ? "text-rose-400" : "text-neutral-500"}>
            要確認 {s.failed}
          </span>
        </div>
      </div>

      {s.pausedForPairing && (
        <p className="mb-2 rounded border border-amber-700 bg-amber-950/50 p-2 text-xs text-amber-200">
          ペアリングが切れたので送信を止めています。
          <strong className="font-bold">記録は消していません。</strong>
          もう一度ペアリングすると続きから送ります。
        </p>
      )}

      {s.entries.length === 0 ? (
        <p className="text-xs text-neutral-500">溜まっているものはありません。</p>
      ) : (
        <ul className="space-y-1">
          {s.entries.map((e) => (
            <li key={e.id}
                className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className={e.state === "failed" ? "text-rose-300" : "text-neutral-200"}>
                  {e.label}
                </span>
                <span className="shrink-0 text-[11px] text-neutral-500">
                  {e.state === "failed" ? "要確認" : `${e.attempts} 回目`}
                </span>
              </div>
              {e.lastError && (
                <p className="mt-0.5 break-all text-[11px] text-neutral-500">{e.lastError}</p>
              )}
              {e.state === "failed" && (
                <button onClick={() => drop(e.id)}
                        className="mt-1 text-[11px] text-neutral-500 underline hover:text-rose-300">
                  これを捨てる
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {/* ★ flush() ではなく kick()。待ち時間が残っていると押しても何も起きない */}
        <Btn onClick={kick}>いま送る</Btn>
        {s.failed > 0 && <Btn onClick={retryFailed}>要確認をもう一度</Btn>}
        {/* ★ 動作確認用。ペアリング画面ができたら消してよい */}
        <Btn onClick={() => enqueuePerformance({ title: "テスト曲", artist: "テスト" })}>
          テストで 1 件積む
        </Btn>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
        ★ ここに積まれるのは「後から足しても意味が変わらないもの」だけです
        （歌唱記録・持ち歌の追加）。キューの並び替えや「今この曲」は、
        古いものを後から送ると画面が壊れるので積みません。
      </p>
    </section>
  );
}

function Btn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
            className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1
                       text-xs hover:bg-neutral-700">
      {children}
    </button>
  );
}
