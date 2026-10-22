// =====================================================================
// 「似ている曲」を見つける
// =====================================================================
//
// ## なぜ要るか
//
// (title_key, artist_key) の完全一致では、次が素通りする:
//
//   夜に駆ける / 夜にかける      漢字↔かな。正規化キーは別物になる
//   YOASOBI  / YAOSOBI        1 文字の入れ替わり
//   Pretender / プリテンダー     表記系がまるごと違う
//
// 素通りすると**同じ曲が別の ID に分裂し、累計回数と最終歌唱日が
// ばらける**。これは配信者自身の集計が壊れることを意味する。
//
// ## 軸を 2 本持つ
//
//   ① 編集距離 … 1 文字の差を拾う。表記系が違うと無力
//   ② 読み     … 表記系が違っても拾う。読みを間違えられると無力
//
// 互いの穴を埋め合う。どちらか 1 本では不十分。
//
// ## これは「拒む」ための判定ではない
//
// 候補を出して**人に確認させる**ための判定。
// 取りこぼし (分裂) の代償のほうが、余計に 1 回確認させる代償より
// はるかに大きいので、広めに拾う。
// =====================================================================

export interface SongLike {
  title: string;
  artist: string;
  /** 読み。無くても動くが、あると精度が大きく上がる */
  reading?: string;
}

/** 比較用に寄せる。全角→半角、カタカナ→ひらがな、記号と空白と長音を落とす */
export function fold(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[ー－‐−-]/g, "")
    .replace(/[\s　!-/:-@[-`{-~、。「」・…～]/g, "");
}

/**
 * 1 文字の入れ替わりも 1 と数える距離 (Optimal String Alignment)。
 * k を超えると分かった時点で打ち切る。
 *
 * ★ 素の Levenshtein だと YOASOBI/YAOSOBI が 2 になり、
 *   7 文字中 2 違い = 他人の空似と区別が付かなくなる。
 */
export function distanceUpTo(a: string, b: string, k: number): number {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > k) return k + 1;
  if (!n) return m;
  if (!m) return n;
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  let prev2: number[] | null = null;
  let cur: number[] = new Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let best = i;
    const lo = Math.max(1, i - k), hi = Math.min(m, i + k);
    for (let j = 1; j < lo; j++) cur[j] = k + 1;
    for (let j = lo; j <= hi; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (i > 1 && j > 1 && prev2 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    for (let j = hi + 1; j <= m; j++) cur[j] = k + 1;
    if (best > k) return k + 1;
    prev2 = prev; prev = cur; cur = new Array(m + 1);
  }
  return prev[m];
}

/** distanceUpTo に渡す上限。これを超える差は「別物」と切り捨てる */
export const MAX_DIST = 2;

/**
 * ★ 短い曲名で「距離 1」を信用してはいけない。
 *     海 / 炎      1 文字どうし
 *     白日 / 白夜   2 文字どうし
 *   どちらも別の曲。4 文字以上のときだけ距離 1 を近いとみなす。
 *
 * ★ **打ち切られた距離を比率に使ってはいけない。**
 *   distanceUpTo は上限を超えると MAX_DIST + 1 を返す。これは
 *   「3 以上」という意味であって 3 ではない。そのまま
 *   1 - d / 長さ に入れると、15 文字と 2 文字の曲が
 *   1 - 3/15 = 0.8 で「似ている」になる。実際の距離は 13。
 *   比率を見てよいのは d <= MAX_DIST のときだけ。
 */
function near(d: number, a: string, b: string): boolean {
  if (d > MAX_DIST) return false;
  const L = Math.max(a.length, b.length);
  return d === 0 || (d <= 1 && L >= 4) || (L > 0 && 1 - d / L >= 0.8);
}

// ── 索引 ────────────────────────────────────────────────
//
// ★ 2 万曲あっても**歌手の種類は桁違いに少ない**。
//   先に「似た歌手」へ絞ると、曲名の距離をかける対象が数十件に落ちる。
//   全件走査 20 ms → 索引あり 1.2 ms (2 万件で実測)。

export interface Indexed<T extends SongLike> {
  row: T;
  t: string; a: string; d: string;
}

export interface SongIndex<T extends SongLike> {
  byArtist: Map<string, Indexed<T>[]>;
  artists: string[];
}

export function buildIndex<T extends SongLike>(rows: readonly T[]): SongIndex<T> {
  const byArtist = new Map<string, Indexed<T>[]>();
  for (const row of rows) {
    const e: Indexed<T> = { row, t: fold(row.title), a: fold(row.artist), d: fold(row.reading ?? "") };
    const list = byArtist.get(e.a);
    if (list) list.push(e); else byArtist.set(e.a, [e]);
  }
  return { byArtist, artists: [...byArtist.keys()] };
}

export interface Candidate<T> { row: T; reason: "reading" | "similar" }

/**
 * 似ている曲を返す。空なら新規として登録してよい。
 *
 * ★ **歌手が近いことを必ず条件にする。**
 *   読みの一致だけで拾うと、同名異アーティストを全部止める:
 *     「アイドル / 乃木坂46」 → 「アイドル / YOASOBI」
 *     「夏空 / Aimer」       → 「夏空 / LiSA」
 *   カバー曲は普通にあるので、これを止めると毎回邪魔になる。
 *   読みは**曲名の揺れを吸収する軸**であって、歌手を飛び越す鍵ではない。
 */
export function findSimilar<T extends SongLike>(
  probe: SongLike, ix: SongIndex<T>,
): Candidate<T>[] {
  const pt = fold(probe.title), pa = fold(probe.artist), pd = fold(probe.reading ?? "");
  const out: Candidate<T>[] = [];

  // ① 近い歌手を選ぶ (走査するのは曲数ではなく歌手の種類数。桁が違う)
  const nearArtists = ix.artists.filter(
    (a) => Math.abs(a.length - pa.length) <= 2 && near(distanceUpTo(pa, a, MAX_DIST), pa, a),
  );

  // ② その歌手の曲だけ、読みと曲名で見る
  for (const a of nearArtists) {
    for (const e of ix.byArtist.get(a)!) {
      if (pd && e.d === pd) out.push({ row: e.row, reason: "reading" });
      else if (near(distanceUpTo(pt, e.t, MAX_DIST), pt, e.t)) out.push({ row: e.row, reason: "similar" });
    }
  }
  return out;
}

/**
 * まとめて照合する。
 *
 * ★ findSimilar を 1 件ずつ呼ぶと、**毎回すべての歌手を走査する**。
 *   POST /songs は最大 500 件を受けるので、そのままだと
 *   500 × 全歌手 になって CPU 予算を割る。
 *   歌手は入力の中で重複することが多い (同じアーティストの曲をまとめて登録する)
 *   ので、「近い歌手の一覧」を歌手ごとに 1 回だけ求めて使い回す。
 */
export function findSimilarMany<T extends SongLike>(
  probes: readonly SongLike[], ix: SongIndex<T>,
): Candidate<T>[][] {
  const nearCache = new Map<string, string[]>();
  return probes.map((probe) => {
    const pt = fold(probe.title), pa = fold(probe.artist), pd = fold(probe.reading ?? "");
    let nearArtists = nearCache.get(pa);
    if (!nearArtists) {
      nearArtists = ix.artists.filter(
        (a) => Math.abs(a.length - pa.length) <= 2 && near(distanceUpTo(pa, a, MAX_DIST), pa, a),
      );
      nearCache.set(pa, nearArtists);
    }
    const out: Candidate<T>[] = [];
    for (const a of nearArtists) {
      for (const e of ix.byArtist.get(a)!) {
        if (pd && e.d === pd) out.push({ row: e.row, reason: "reading" });
        else if (near(distanceUpTo(pt, e.t, MAX_DIST), pt, e.t)) out.push({ row: e.row, reason: "similar" });
      }
    }
    return out;
  });
}
