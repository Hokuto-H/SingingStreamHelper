import { normalizeKey, prefixRange } from './keys';
import { titleColumnFor } from './search';

/**
 * バックエンドにおく、「最近検索された曲」のインデックス
 * 同じisolateからのアクセスであれば、変数でも問題ないかもしれないが、
 * Cloudflare Workersのように、複数のisolateからアクセスされる場合、同じ中身を共有できないので、
 * KVに保存する
 */

export interface HotSong {
	id: string;
	title: string;
	readingTitle: string;
	artist: string;
	createdAt: string;
}

// KVに保存する形。配列にしてJSONを小さくする
export interface Snapshot {
	version: string;
	coversAll: boolean; // 作成時点でマスタ全曲を含んでいたか
	rows: [string, string, string, string, string][]; // [id, title, readingTitle, artist, createdAt]
}

interface SortedKeys {
	keys: string[];
	at: Int32Array; // keys[i]に対応する songsのインデックス
}

export interface HotIndex {
	version: string;
	coversAll: boolean;
	stale: boolean; // スナップショット作成後に曲が登録されたか
	songs: HotSong[];
	reading: SortedKeys;
	title: SortedKeys;
	artist: SortedKeys;
}

export function isComplete(ix: HotIndex): boolean {
	return ix.coversAll && !ix.stale;
}

export interface HotResult {
	items: HotSong[];
	complete: boolean; // true: マスタDBの正解と一致 false: 手持ちから拾っただけの候補
}

export function buildIndex(snap: Snapshot): HotIndex {
	const songs: HotSong[] = snap.rows.map(
		([id, title, readingTitle, artist, createdAt]) => ({
			id,
			title,
			readingTitle,
			artist,
			createdAt,
		}),
	);
	const keyOf = {
		reading: (s: HotSong) => normalizeKey(s.readingTitle),
		title: (s: HotSong) => normalizeKey(s.title),
		artist: (s: HotSong) => normalizeKey(s.artist),
	};
	const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

	// マスタDBと同じソート順で並べる
	// reading / title -> (key, id)
	// artist -> (artist_key, reading_key, id)
	const sortBy = (
		f: (s: HotSong) => string,
		tie?: (s: HotSong) => string,
	): SortedKeys => {
		const pairs = songs.map((s, i) => [f(s), i] as [string, number]);
		pairs.sort(
			(a, b) =>
				cmp(a[0], b[0]) ||
				(tie ? cmp(tie(songs[a[1]]), tie(songs[b[1]])) : 0) ||
				cmp(songs[a[1]].id, songs[b[1]].id),
		);
		return {
			keys: pairs.map((p) => p[0]),
			at: Int32Array.from(pairs.map((p) => p[1])),
		};
	};
	return {
		version: snap.version,
		coversAll: snap.coversAll,
		stale: false,
		songs,
		reading: sortBy(keyOf.reading),
		title: sortBy(keyOf.title),
		artist: sortBy(keyOf.artist, keyOf.reading),
	};
}

// ニ分探索
// keys[i] >= targetとなる最小のi
function lowerBound(keys: string[], target: string): number {
	let lo = 0,
		hi = keys.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (keys[mid] < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function searchHot(
	index: HotIndex,
	q: { title?: string; artist?: string; limit?: number },
): HotResult {
	const limit = q.limit ?? 20;
	const titleKey = q.title ? normalizeKey(q.title) : '';
	const artistKey = q.artist ? normalizeKey(q.artist) : '';

	if ((q.title && !titleKey) || (q.artist && !artistKey)) {
		return { items: [], complete: isComplete(index) };
	}

	let sorted: SortedKeys;
	let prefix: string;
	let secondary: ((s: HotSong) => boolean) | null = null;

	if (titleKey) {
		sorted =
			titleColumnFor(titleKey) === 'reading_key'
				? index.reading
				: index.title;
		prefix = titleKey;
		if (artistKey) {
			const [alo, ahi] = prefixRange(artistKey);
			secondary = (s) => {
				const k = normalizeKey(s.artist);
				return k >= alo && k < ahi;
			};
		}
	} else if (artistKey) {
		sorted = index.artist;
		prefix = artistKey;
	} else {
		// 絞り込みがない場合：あいうえお順の先頭から
		const items: HotSong[] = [];
		for (
			let i = 0;
			i < index.reading.at.length && items.length < limit;
			i++
		) {
			items.push(index.songs[index.reading.at[i]]);
		}
		return { items, complete: isComplete(index) };
	}

	const [lo, hi] = prefixRange(prefix);
	const items: HotSong[] = [];
	for (let i = lowerBound(sorted.keys, lo); i < sorted.keys.length; i++) {
		if (sorted.keys[i] >= hi) break;
		const s = index.songs[sorted.at[i]];
		if (secondary && !secondary(s)) continue;
		items.push(s);
		if (items.length >= limit) break;
	}

	// 振り分けが外れた場合の保険
	if (items.length === 0 && titleKey) {
		const other = sorted === index.reading ? index.title : index.reading;
		const [lo2, hi2] = prefixRange(titleKey);
		for (let i = lowerBound(other.keys, lo2); i < other.keys.length; i++) {
			if (other.keys[i] >= hi2) break;
			const s = index.songs[other.at[i]];
			if (secondary && !secondary(s)) continue;
			items.push(s);
			if (items.length >= limit) break;
		}
	}

	return { items, complete: isComplete(index) };
}

// isolateの中で使い回す
interface KVLike {
	get(key: string, type: 'text'): Promise<string | null>;
	get(
		key: string,
		opts: { type: 'json'; cacheTtl?: number },
	): Promise<unknown>;
	put(key: string, value: string): Promise<void>;
}

let memo: HotIndex | null = null;
let memoCheckedAt = 0;

// バージョン確認の間隔
// KVはget()で1 readとなる。無料枠は1日100,000 read
// 確認が1分だと、60*24=1440 read/day * isolatesで、数十あると数万read/dayとなる
// 曲のマスタDBの読み込みは10分で十分であり、こうすることで1桁少ないread数で済む
const VERSION_CHECK_MS = 10 * 60 * 1000;

export const SNAPSHOT_KEY = 'hot:snapshot';
export const VERSION_KEY = 'hot:version';
// 最後に曲が追加された時刻、versionより新しい場合、stale=true
export const STALE_KEY = 'hot:stale';

// KVからスナップショットを取得して、isolateのメモリに載せる
// 2回目以降はKVに行かない
export async function loadHotIndex(kv: KVLike): Promise<HotIndex | null> {
	const now = Date.now();
	if (memo && now - memoCheckedAt < VERSION_CHECK_MS) return memo;
	const [version, staleAt] = await Promise.all([
		kv.get(VERSION_KEY, 'text'),
		kv.get(STALE_KEY, 'text'),
	]);
	memoCheckedAt = now;
	if (!version) return memo;

	if (!memo || memo.version !== version) {
		const snap = (await kv.get(SNAPSHOT_KEY, {
			type: 'json',
			cacheTtl: 300,
		})) as Snapshot | null;
		if (!snap) return memo;

		memo = buildIndex(snap);
	}

	// スナップショットより後に曲が追加されていたら全件とは言えない
	memo.stale = Number(staleAt ?? 0) > Number(memo.version);
	return memo;
}

// 曲が登録されたことを記録する。
// POST /songsから waitUntil で呼ぶ
export async function markSnapshotStale(kv: KVLike): Promise<void> {
	await kv.put(STALE_KEY, String(Date.now()));
}

// テスト用
export function resetHotIndex(): void {
	memo = null;
	memoCheckedAt = 0;
}

export function setBundleSnapshot(snap: Snapshot): void {
	memo = buildIndex(snap);
	memoCheckedAt = Number.MAX_SAFE_INTEGER; // KVを確認させないようにする
}

// スナップショットを作り、KVに書く
export async function putSnapshot(
	kv: KVLike,
	rows: Snapshot['rows'],
	coversAll: boolean,
	version = String(Date.now()),
): Promise<void> {
	const snap: Snapshot = { version, coversAll, rows };
	await kv.put(SNAPSHOT_KEY, JSON.stringify(snap));
	await kv.put(VERSION_KEY, version);
}
