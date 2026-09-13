// トークンから配信者情報を取得する層
// 1リクエストにつき最大1クエリ2行
// Tursoの読み取りを減らすために、
// 1. JOIN1本で取得する
// 2. isolateメモリにキャッシュする
// 3. 失敗もキャッシュする
// 4. last_used_atの書き込みを間引く
// 5. スプレッドシート名をDBに持つ

import type { Client } from '@libsql/client/web';
import { hashToken, issueToken, looksLikeToken } from './auth';

// 型
export type TokenScope = 'full' | 'dock';

export interface Session {
	streamerId: string; // 配信者ID UUIDv7
	spreadsheetId: string; // スプレッドシートID
	repertoireSheet: string; // レパートリータブのタブ名
	historySheet: string; // 歌唱履歴タブのタブ名
	timezone: string; // スプレッドシートのタイムゾーン
	spreadsheetTitle: string | null; // スプレッドシートのファイル名。Googleから取れない場合はnull
	titleSyncedAt: number | null; // spreadsheetTitleを最後に同期した時刻。未取得ならnull
	displayName: string | null; // 配信者の表示名。未取得ならnull
	isPublic: boolean; // 視聴者向けの公開ページを有効にしているかどうか
	streamerCreatedAt: number; // 配信者アカウントの作成時刻
	scope: TokenScope; // トークンのスコープ
	tokenHash: string; // 検証に使ったトークンのハッシュ値
	tokenLabel: string | null;
}

// isolate ローカルキャッシュ
interface Entry {
	// nullは無効なトークン
	value: Session | null;
	expiresAt: number;
	lastUsedAt: number;
}

const POSITIVE_TTL_MS = 60 * 1000; // 執行猶予1分
const NEGATIVE_TTL_MS = 30 * 1000; // 総当り対策
const TOUCH_INTERVAL_MS = 10 * 60 * 1000; // last_used_atの書き込み間隔。10分に1回
const MAX_ENTRIES = 2000; // isolateの最大エントリ数。Tursoの読み取りを減らすために、古いものから削除する

const cache = new Map<string, Entry>();

function cacheGet(key: string): Entry | undefined {
	const e = cache.get(key);
	if (!e) return undefined;
	if (e.expiresAt <= Date.now()) {
		cache.delete(key);
		return undefined;
	}
	cache.delete(key);
	cache.set(key, e);
	return e;
}

function cacheSet(key: string, e: Entry): void {
	cache.delete(key);
	cache.set(key, e);
	while (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

export function invalidateToken(tokenHash: string): void {
	cache.delete(tokenHash);
}

// 配信者に紐づくすべてのキャッシュを捨てる
export function invalidateStreamer(streamerId: string): void {
	for (const [k, e] of cache) {
		if (e.value?.streamerId === streamerId) cache.delete(k);
	}
}

// 解決
const RESOLVE_SQL = `
SELECT
    s.id AS streamer_id,
    s.spreadsheet_id,
    s.repertoire_sheet,
    s.history_sheet,
    s.timezone,
    s.spreadsheet_title,
    s.title_synced_at,
    s.display_name,
	s.is_public,
    s.created_at AS streamer_created_at,
    t.scope,
    t.label AS token_label,
    t.last_used_at
FROM streamer_tokens t
JOIN streamers s ON s.id = t.streamer_id
WHERE t.token_hash = ? AND t.revoked_at IS NULL`;

export interface ResolveOptions {
	waitUntil?: (p: Promise<unknown>) => void;
	fresh?: boolean; // キャッシュを無視してDBから取得する
}

// 平文トークンからセッションを取得する
export async function resolveSession(
	db: Client,
	token: string,
	opts: ResolveOptions = {},
): Promise<Session | null> {
	if (!looksLikeToken(token)) return null;

	const tokenHash = await hashToken(token);

	if (!opts.fresh) {
		const hit = cacheGet(tokenHash);
		if (hit) {
			if (hit.value) touch(db, tokenHash, hit, opts.waitUntil);
			return hit.value;
		}
	}

	const rs = await db.execute({ sql: RESOLVE_SQL, args: [tokenHash] });
	const row = rs.rows[0] as unknown as ResolveRow | undefined;

	if (!row) {
		cacheSet(tokenHash, {
			value: null,
			expiresAt: Date.now() + NEGATIVE_TTL_MS,
			lastUsedAt: 0,
		});
		return null;
	}

	const session: Session = {
		streamerId: String(row.streamer_id),
		spreadsheetId: String(row.spreadsheet_id),
		repertoireSheet: String(row.repertoire_sheet),
		historySheet: String(row.history_sheet),
		timezone: String(row.timezone),
		spreadsheetTitle:
			row.spreadsheet_title == null
				? null
				: String(row.spreadsheet_title),
		titleSyncedAt:
			row.title_synced_at == null ? null : Number(row.title_synced_at),
		displayName: row.display_name == null ? null : String(row.display_name),
		isPublic: Number(row.is_public) === 1,
		streamerCreatedAt: Number(row.streamer_created_at),
		scope: normalizeScope(row.scope),
		tokenHash,
		tokenLabel: row.token_label == null ? null : String(row.token_label),
	};

	const entry: Entry = {
		value: session,
		expiresAt: Date.now() + POSITIVE_TTL_MS,
		lastUsedAt: row.last_used_at == null ? 0 : Number(row.last_used_at),
	};
	cacheSet(tokenHash, entry);
	touch(db, tokenHash, entry, opts.waitUntil);

	return session;
}

interface ResolveRow {
	streamer_id: unknown;
	spreadsheet_id: unknown;
	repertoire_sheet: unknown;
	history_sheet: unknown;
	timezone: unknown;
	spreadsheet_title: unknown;
	title_synced_at: unknown;
	display_name: unknown;
	is_public: unknown;
	streamer_created_at: unknown;
	scope: unknown;
	token_label: unknown;
	last_used_at: unknown;
}

function normalizeScope(v: unknown): TokenScope {
	return v === 'full' ? 'full' : 'dock';
}

// last_used_atの更新
// 毎回書くと、1リクエストで1writeになるので、間引く
function touch(
	db: Client,
	tokenHash: string,
	entry: Entry,
	waitUntil?: (p: Promise<unknown>) => void,
): void {
	const now = Date.now();
	if (now - entry.lastUsedAt < TOUCH_INTERVAL_MS) return;
	entry.lastUsedAt = now;
	const p = db
		.execute({
			sql: `UPDATE streamer_tokens SET last_used_at = ? WHERE token_hash = ?`,
			args: [now, tokenHash],
		})
		.then(() => undefined)
		.catch(() => undefined);

	if (waitUntil) waitUntil(p);
}

// トークンの発行と失効
export interface IssuedToken {
	token: string;
	tokenHash: string;
	scope: TokenScope;
	label: string | null;
}

// トークンを発行して保存する
export async function issueTokenFor(
	db: Client,
	streamerId: string,
	scope: TokenScope,
	label: string | null = null,
): Promise<IssuedToken> {
	const { token, hash: tokenHash } = await issueToken();
	await db.execute({
		sql: `INSERT INTO streamer_tokens (token_hash, streamer_id, scope, label, created_at) VALUES (?, ?, ?, ?, ?)`,
		args: [tokenHash, streamerId, scope, label, Date.now()],
	});
	return { token, tokenHash, scope, label };
}

// トークンを失効する
export async function revokeTokenByPrefix(
	db: Client,
	streamerId: string,
	prefix: string,
): Promise<string[]> {
	const rs = await db.execute({
		sql: `UPDATE streamer_tokens SET revoked_at = ? WHERE streamer_id = ? AND revoked_at IS NULL AND substr(token_hash, 1, 8) = ? RETURNING token_hash`,
		args: [Date.now(), streamerId, prefix],
	});
	const hashes = rs.rows.map((r) =>
		String((r as unknown as { token_hash: unknown }).token_hash),
	);
	for (const h of hashes) invalidateToken(h);
	return hashes;
}

export async function revokeAllDockTokens(
	db: Client,
	streamerId: string,
): Promise<number> {
	const rs = await db.execute({
		sql: `UPDATE streamer_tokens SET revoked_at = ? WHERE streamer_id = ? AND scope = 'docke' AND revoked_at IS NULL RETURNING token_hash`,
		args: [Date.now(), streamerId],
	});
	for (const r of rs.rows) {
		invalidateToken(
			String((r as unknown as { token_hash: unknown }).token_hash),
		);
	}
	return rs.rows.length;
}

// スプレッドシート名のキャッシュ

const TITLE_TTL_MS = 24 * 60 * 60 * 1000; // 1日

// スプレッドシートの名前をDBに保存することで、/meでGoogleに問い合わせる回数を減らす
export async function saveSpreadsheetTitle(
	db: Client,
	streamerId: string,
	title: string,
	timeZone?: string,
): Promise<void> {
	await db.execute({
		sql: timeZone
			? `UPDATE streamers SET spreadsheet_title = ?, title_synced_at = ?, timezone = ? WHERE id = ?`
			: `UPDATE streamers SET spreadsheet_title = ?, title_synced_at = ? WHERE id = ?`,
		args: timeZone
			? [title, Date.now(), timeZone, streamerId]
			: [title, Date.now(), streamerId],
	});
	invalidateStreamer(streamerId);
}

export function titleIsStale(titleSyncedAt: number | null): boolean {
	return titleSyncedAt == null || Date.now() - titleSyncedAt > TITLE_TTL_MS;
}
