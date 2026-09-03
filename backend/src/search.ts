import { isKanaOnly, normalizeKey, prefixRange } from './keys';

export const MAX_WINDOW = 200;
export const MAX_LIMIT = 200;

export type TitleColumn = 'reading_key' | 'title_key';

export interface SearchParams {
	title?: string;
	artist?: string;
	limit: number;
	page: number;
	forceTitleColumn?: TitleColumn;
}

export interface BuiltQuery {
	sql: string;
	args: (string | number)[];
	titleColumn: TitleColumn | null;
	limit: number; // 検索結果の上限件数
	atWindowEnd: boolean; // 検索結果がウィンドウの最後まで到達した場合にtrueになる
	noCriteria: boolean; // titleもartistも指定されないた場合、400エラーを返すためにtrueになる
	empty: boolean; // 正規化したあとに検索後が空になった場合にtrueになる
}

const DISPLAY_COLS = ['id', 'title', 'reading_title', 'artist', 'created_at'];

/**
 * 検索文字列がreading_keyで検索すべきか、title_keyで検索すべきかを判定する
 * @param titleKey 検索文字列
 * @returns 検索に使用するカラム名
 */
export function titleColumnFor(titleKey: string): TitleColumn {
	return isKanaOnly(titleKey) ? 'reading_key' : 'title_key';
}

/**
 * どのインデックスを使って検索するのかを決定する。
 * 例えばreading_keyとartist_keyの両方が検索条件として指定されていたとしたら、reading_keyのインデックスを使って最初に検索するため、返すのは['reading_key', 'id]になる
 * @param titleColumn 検索に使用するカラム名
 * @returns SQLのORDER BY句に指定する列名の配列を返す。
 */
export function orderColumnsFor(titleColumn: TitleColumn | null): string[] {
	if (titleColumn === 'title_key') return ['title_key', 'id'];
	if (titleColumn === 'reading_key') return ['reading_key', 'id'];
	return ['artist_key', 'title_key', 'id'];
}

/**
 * 入力のページ番号と上限件数から、検索結果の上限件数を超えているかどうかを判定する
 * @param limit 検索上限件数
 * @param page 入力のページ番号
 * @returns ページが検索上限を超えているならtrueを返す
 */
export function isPageOutOfWindow(limit: number, page: number): boolean {
	return (page - 1) * Math.min(limit, MAX_LIMIT) >= MAX_WINDOW;
}

/**
 * エッジキャッシュ用の正規化されたキー
 *
 * URLをそのままキーにすると、大文字小文字の違いや、ひらがな/カタカナの違いでエントリが分かれてしまう。
 * normalizeKeyと合わせて使い、正規化することで1つにできる
 * @param titleKey 正規化された入力曲名
 * @param artistKey 正規化された歌手名
 * @param limit 検索上限
 * @param page ページ番号
 */
export function cacheKeyOf(
	titleKey: string,
	artistKey: string,
	limit: number,
	page: number,
): string {
	const p = new URLSearchParams();
	if (titleKey) p.set('t', titleKey);
	if (artistKey) p.set('a', artistKey);
	p.set('l', String(limit));
	p.set('p', String(page));
	return p.toString();
}

/**
 * 検索条件を受け取り、検索条件に沿ったSQLのクエリを生成する
 * @param p 検索条件
 * @returns 生成されたクエリ
 */
export function buildSearchQuery(p: SearchParams): BuiltQuery {
	const titleKey = p.title ? normalizeKey(p.title) : '';
	const artistKey = p.artist ? normalizeKey(p.artist) : '';

	const noCriteria = !p.title && !p.artist;

	const empty =
		noCriteria || (!!p.title && !titleKey) || (!!p.artist && !artistKey);

	const titleColumn = titleKey
		? (p.forceTitleColumn ?? titleColumnFor(titleKey))
		: null;

	const orderCols = orderColumnsFor(titleColumn);

	const where: string[] = [];
	const args: (string | number)[] = [];

	if (empty) where.push('0');

	const pushPrefix = (col: string, key: string) => {
		const [lo, hi] = prefixRange(key);
		where.push(`${col} >= ? AND ${col} < ?`);
		args.push(lo, hi);
	};

	if (titleKey) pushPrefix(titleColumn!, titleKey);
	if (artistKey) pushPrefix('artist_key', artistKey);

	const reqLimit = Math.min(Math.max(p.limit, 1), MAX_LIMIT);
	const offset = (Math.max(p.page, 1) - 1) * reqLimit;
	const limit = Math.max(Math.min(reqLimit, MAX_WINDOW - offset), 0);
	const atWindowEnd = offset + limit >= MAX_WINDOW;

	const sql = [
		`SELECT ${DISPLAY_COLS.join(', ')}`,
		'FROM songs',
		where.length
			? `WHERE ${where.map((w) => `(${w})`).join('\n AND ')}`
			: '',
		`ORDER BY ${orderCols.join(', ')}`,
		'LIMIT ?',
		offset > 0 ? 'OFFSET ?' : '',
	]
		.filter(Boolean)
		.join('\n');

	args.push(limit + 1);
	if (offset > 0) args.push(offset);

	return { sql, args, titleColumn, limit, atWindowEnd, noCriteria, empty };
}
