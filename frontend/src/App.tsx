import { useEffect, useState } from "react";
import { ApiError, api } from "./lib/api";
import { API_BASE } from "./lib/config";
import { Outbox } from "./ui/outbox";
import { startOutbox } from "./lib/outbox";
import { getToken } from "./lib/token";

/**
 * STEP 2 の足場。まだ機能は無い。
 *
 * ★ この画面の目的はひとつだけ:
 *   **作ったものが OBS のドックの中で動くことを確かめる。**
 *
 *   OBS のドックは OBS 同梱の CEF で動く。普段のブラウザで動いても
 *   ドックで真っ白、ということがある。検索もキューも作ってから
 *   それに気づくと、どこが悪いのか切り分けられない。
 *   だから**何も作っていない今**、先に通しておく。
 */

type Health = { ok?: boolean; [k: string]: unknown };

function chromeVersion(ua: string): string | null {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m ? m[1] : null;
}

export default function App() {
  useEffect(() => startOutbox(), []);

  const ua = navigator.userAgent;
  const chrome = chromeVersion(ua);

  const [health, setHealth] = useState<string>("確認中…");
  const [healthOk, setHealthOk] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    api<Health>("/health", { anonymous: true })
      .then((r) => {
        if (!alive) return;
        setHealthOk(true);
        setHealth(JSON.stringify(r));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setHealthOk(false);
        const err = e instanceof ApiError ? e : null;
        setHealth(
          err?.offline
            ? "届きませんでした。URL が違うか、CORS で弾かれています"
            : String(e instanceof Error ? e.message : e),
        );
      });
    return () => { alive = false; };
  }, []);

  const token = getToken();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 text-sm">
      <div className="mx-auto max-w-md p-3 space-y-3">
        <header>
          <h1 className="text-base font-bold">SingingStreamHelper ドック</h1>
          <p className="text-xs text-neutral-400">
            足場の確認用です。機能はまだ入っていません。
          </p>
        </header>

        <Card title="① このドックのブラウザ">
          <Row label="Chrome">
            {chrome ? (
              <span className="font-mono text-base font-bold text-amber-300">{chrome}</span>
            ) : (
              <span className="text-neutral-400">読み取れませんでした</span>
            )}
          </Row>
          <p className="mt-2 text-xs leading-relaxed text-neutral-400">
            ★ この数字を <code className="text-neutral-200">vite.config.ts</code> の{" "}
            <code className="text-neutral-200">build.target</code> に入れてください
            （例: <code className="text-neutral-200">chrome{chrome ?? "108"}</code>）。
            合っていないと、作り込んだ後でドックだけ真っ白になります。
          </p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-neutral-400">
              userAgent 全体
            </summary>
            <p className="mt-1 break-all font-mono text-[11px] text-neutral-500">{ua}</p>
          </details>
        </Card>

        <Card title="② バックエンドに届くか">
          <Row label="接続先">
            <span className="break-all font-mono text-xs">{API_BASE}</span>
          </Row>
          <Row label="/health">
            <span className={healthOk === null ? "text-neutral-400"
              : healthOk ? "text-emerald-400" : "text-rose-400"}>
              {healthOk === null ? "確認中…" : healthOk ? "OK" : "NG"}
            </span>
          </Row>
          <p className="mt-1 break-all font-mono text-[11px] text-neutral-500">{health}</p>
          {healthOk === false && (
            <p className="mt-2 text-xs leading-relaxed text-amber-300">
              ★ 開発中にここが NG なら、まず <code>ALLOWED_ORIGINS</code> に{" "}
              <code>{location.origin}</code> が入っているか確認してください。
              CORS で弾かれた場合も「届かなかった」と同じ形で見えます。
            </p>
          )}
        </Card>

        <Card title="③ ペアリング">
          <Row label="トークン">
            {token
              ? <span className="text-emerald-400">保存済み（{token.length} 文字）</span>
              : <span className="text-neutral-400">まだです</span>}
          </Row>
          <p className="mt-2 text-xs text-neutral-400">
            ペアリング画面は次に作ります。
          </p>
        </Card>

        <Outbox />
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <h2 className="mb-2 text-xs font-bold tracking-wide text-neutral-400">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-xs text-neutral-400">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
