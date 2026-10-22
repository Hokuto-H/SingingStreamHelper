// =====================================================================
// 曲マスタへの登録ゲート
// =====================================================================
//
// ## 何のためにあるか
//
// (title_key, artist_key) のユニーク制約は**完全一致しか見ない**。
// 次のような打ち間違いは素通りして、同じ曲が別の ID に分裂する。
//
//   夜に駆ける / 夜にかける      漢字↔かな
//   YOASOBI  / YAOSOBI        1 文字の入れ替わり
//   Pretender / プリテンダー     表記系がまるごと違う
//
// 分裂すると、Repertoire の「累計回数」「最終歌唱日」は
// COUNTIF / VLOOKUP で songId を突き合わせているので**ばらける**。
// 被害を受けるのは配信者自身なので、入口で止める。
//
// ## 2 本立てにしている理由
//
//   ① 読み (reading_key) の完全一致 … **マスタDBに直接引きに行く**
//   ② 編集距離による近さ           … KV スナップショットの上で探す
//
// ①を DB に行かせるのは、スナップショットが古いことがあるため。
// 読みは一番強い手がかりなので、**常に最新のマスタで照合する**。
// ②は多少取りこぼしても「次の夜のスナップショットで拾える」範囲に収まる。
//
// HOT (KV) が未設定でも①だけは動く。
// =====================================================================

import type { Client } from '@libsql/client/web';

import { isComplete, type HotIndex, type HotSong } from './hotIndex';
import { normalizeKey } from './keys';
import {
	MAX_DIST,
	buildIndex as buildSimIndex,
	distanceUpTo,
	findSimilarMany,
	fold,
	type SongIndex,
} from './similar';

export interface GateInput {
	title: string;
	readingTitle: string;
	artist: string;
}

export interface GateCandidate {
	id: string;
	title: string;
	artist: string;
	/** reading = 読みが一致 / similar = 字面が近い */
	reason: 'reading' | 'similar';
}

/** ★ スナップショット 1 版につき 1 回だけ索引を組む。isolate の中で使い回す */
let simMemo: { version: string; ix: SongIndex<HotSong> } | null = null;

function simIndexOf(hot: HotIndex): SongIndex<HotSong> {
	if (simMemo && simMemo.version === hot.version) return simMemo.ix;
	const ix = buildSimIndex(
		hot.songs.map((s) => ({ ...s, reading: s.readingTitle })),
	) as unknown as SongIndex<HotSong>;
	simMemo = { version: hot.version, ix };
	return ix;
}

/** テスト用 */
export function resetSimIndex(): void {
	simMemo = null;
}

/**
 * 歌手が近いか。
 *
 * ★ 読みが一致しただけで拾うと、**同名異アーティストを全部止める**。
 *     「アイドル / 乃木坂46」 → 「アイドル / YOASOBI」
 *   カバー曲は普通にあるので、歌手の近さを必ず条件にする。
 */
function artistClose(a: string, b: string): boolean {
	const x = fold(a), y = fold(b);
	if (Math.abs(x.length - y.length) > MAX_DIST) return false;
	const d = distanceUpTo(x, y, MAX_DIST);
	if (d > MAX_DIST) return false;
	const L = Math.max(x.length, y.length);
	return d === 0 || (d <= 1 && L >= 4) || (L > 0 && 1 - d / L >= 0.8);
}

/**
 * 入力ごとに「似ている既存曲」を返す。
 *
 * @returns 入力の添字 -> 候補。候補が無い添字は入らない
 */
export async function findDuplicateCandidates(
	db: Client,
	inputs: readonly GateInput[],
	hot: HotIndex | null,
): Promise<Map<number, GateCandidate[]>> {
	const found = new Map<number, Map<string, GateCandidate>>();
	const add = (i: number, c: GateCandidate) => {
		const m = found.get(i) ?? new Map<string, GateCandidate>();
		// ★ 同じ曲を 2 回入れない。reading のほうが強い手がかりなので優先
		if (!m.has(c.id) || c.reason === 'reading') m.set(c.id, c);
		found.set(i, m);
	};

	// ── ① 読みの完全一致をマスタDBに引きに行く ──────────────
	const readingKeys = inputs.map((x) => normalizeKey(x.readingTitle));
	const uniq = [...new Set(readingKeys.filter(Boolean))];
	if (uniq.length > 0) {
		const rs = await db.execute({
			sql: `SELECT id, title, artist, reading_key FROM songs WHERE reading_key IN (${uniq
				.map(() => '?')
				.join(', ')})`,
			args: uniq,
		});
		const byKey = new Map<string, { id: string; title: string; artist: string }[]>();
		for (const r of rs.rows as unknown as Record<string, string>[]) {
			const k = String(r.reading_key);
			const list = byKey.get(k);
			const row = { id: String(r.id), title: String(r.title), artist: String(r.artist) };
			if (list) list.push(row); else byKey.set(k, [row]);
		}
		inputs.forEach((input, i) => {
			for (const row of byKey.get(readingKeys[i]) ?? []) {
				if (artistClose(input.artist, row.artist)) {
					add(i, { ...row, reason: 'reading' });
				}
			}
		});
	}

	// ── ② 字面の近さをスナップショットの上で探す ──────────────
	//
	// ★ スナップショットは最大 20,000 曲で、古いことがある。
	//   取りこぼしは①と、夜のスナップショット更新で縮む。
	if (hot) {
		const probes = inputs.map((x) => ({
			title: x.title,
			artist: x.artist,
			reading: x.readingTitle,
		}));
		const results = findSimilarMany(probes, simIndexOf(hot));
		results.forEach((cands, i) => {
			for (const c of cands) {
				add(i, {
					id: c.row.id,
					title: c.row.title,
					artist: c.row.artist,
					reason: c.reason,
				});
			}
		});
	}

	const out = new Map<number, GateCandidate[]>();
	for (const [i, m] of found) out.set(i, [...m.values()]);
	return out;
}

/** 応答に添えるひとこと。スナップショットが不完全なら正直に言う */
export function gateNote(hot: HotIndex | null): string | undefined {
	if (!hot) return '曲のスナップショットが未設定のため、読みの一致だけで確認しました。';
	if (!isComplete(hot)) {
		return '曲のスナップショットが最新ではないため、取りこぼしの可能性があります。';
	}
	return undefined;
}
