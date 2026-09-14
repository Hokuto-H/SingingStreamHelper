import { Hono, Env, ValidationTargets } from 'hono';
import { zValidator, Hook } from '@hono/zod-validator';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { createClient, LibsqlError, type Client } from '@libsql/client/web';

import { normalizeKey } from './keys';
import {
	loadHotIndex,
	markSnapshotStale,
	putSnapshot,
	searchHot,
	type Snapshot,
} from './hotIndex';
import { type BuiltQuery, buildSearchQuery, cacheKeyOf } from './search';
import {
	type Song,
	createQuerySchema,
	createSongsSchema,
	searchQuerySchema,
	suggestQuerySchema,
} from './scheme';
import { pairing, PairingDO } from './pairing';
import { publicRoutes } from './public';
import { purgeSyncedPerformances, streamers } from './streamers';
import type { Session } from './session';
import type { SheetsEnv } from './sheets';

export type Bindings = SheetsEnv & {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
	// hotインデックスのスナップショット置き場
	HOT?: KVNamespace;
	PAIRING: DurableObjectNamespace;
};

export type Variables = {
	db: Client;
	session: Session;
};

const db = (env: Bindings): Client =>
	createClient({
		url: env.TURSO_DATABASE_URL,
		authToken: env.TURSO_AUTH_TOKEN,
	});

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const onInvalid: Hook<
	unknown,
	Env,
	string,
	keyof ValidationTargets,
	Record<string, unknown>,
	z.ZodType
> = (result, c) => {
	if (result.success) return;

	const issues = result.error.issues.map((i) => ({
		path: i.path.join('.') || '(root)',
		message: i.message,
	}));

	return c.json({ error: 'invalid request', issues }, 400);
};

app.use('*', async (c, next) => {
	if (!c.get('db')) {
		const client = db(c.env);
		c.set('db', client);
	}
	await next();
});

app.onError((err, c) => {
	console.error(`[Error ${c.req.method} ${c.req.url}]`, err);

	if (err.message?.includes('UNIQUE constraint failed')) {
		return c.json(
			{
				error: 'このデータ（曲名・歌手の組み合わせ等）は既に登録されています',
			},
			409,
		);
	}

	if (err instanceof SyntaxError) {
		return c.json({ error: '不正なJSONリクエストです' }, 400);
	}

	if (err instanceof LibsqlError) {
		return c.json(
			{ error: 'Database operation failed', detail: err.message },
			500,
		);
	}

	return c.json({ error: 'Internal Server Error' }, 500);
});

app.post(
	'/songs',
	zValidator('query', createQuerySchema, onInvalid),
	zValidator('json', createSongsSchema, onInvalid),
	async (c) => {
		// 曲をマスターDBに登録する
		const { onDuplicate } = c.req.valid('query');
		const input = c.req.valid('json');
		const conn = c.get('db');

		const now = Date.now();
		const candidates = input.map((s) => ({
			...s,
			titleKey: normalizeKey(s.title),
			readingKey: normalizeKey(s.readingTitle),
			artistKey: normalizeKey(s.artist),
		}));

		// リクエスト内の重複確認(複数リクエストに対応する場合)
		const seen = new Map<string, number>();
		const skipped: {
			title: string;
			artist: string;
			existingId: string | null;
		}[] = [];
		const unique: typeof candidates = [];
		for (const cand of candidates) {
			const nk = `${cand.titleKey} ${cand.artistKey}`;
			if (seen.has(nk)) {
				skipped.push({
					title: cand.title,
					artist: cand.artist,
					existingId: null,
				});
				continue;
			}
			seen.set(nk, unique.length);
			unique.push(cand);
		}

		// マスターDBの重複確認
		// (title_key, artist_key)の組み合わせのユニーク制約が効く
		const dup = await conn.execute({
			sql: `SELECT id, title, artist, title_key, artist_key FROM songs WHERE (title_key, artist_key) IN (VALUES ${unique.map(() => '(?, ?)').join(', ')})`,
			args: unique.flatMap((u) => [u.titleKey, u.artistKey]),
		});
		const existing = new Map<string, string>();
		for (const r of dup.rows as unknown as Record<string, string>[]) {
			existing.set(`${r.title_key} ${r.artist_key}`, String(r.id));
		}

		const fresh = unique.filter((u) => {
			const id = existing.get(`${u.titleKey} ${u.artistKey}`);
			if (id === undefined) return true;
			skipped.push({ title: u.title, artist: u.artist, existingId: id });
			return false;
		});

		if (onDuplicate === 'error' && skipped.length > 0) {
			return c.json(
				{
					error: 'duplicate song',
					message:
						'同じアーティストの同じ曲名がすでに登録されています。',
					duplicates: skipped,
				},
				409,
			);
		}
		if (fresh.length === 0) {
			return c.json({ created: [], skipped }, 200);
		}

		// 登録処理
		// ON CONFLICT DO NOTHINGで同時リクエストのすり抜けを防ぐ
		const created: Song[] = [];
		const results = await conn.batch(
			fresh.map((r) => {
				const id = uuidv7();
				created.push({
					id,
					title: r.title,
					readingTitle: r.readingTitle,
					artist: r.artist,
					createdAt: new Date(now).toISOString(),
				});
				return {
					sql: `INSERT INTO songs (id, title, reading_title, artist, title_key, reading_key, artist_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (title_key, artist_key) DO NOTHING RETURNING id`,
					args: [
						id,
						r.title,
						r.readingTitle,
						r.artist,
						r.titleKey,
						r.readingKey,
						r.artistKey,
						now,
					],
				};
			}),
			'write',
		);

		// RETURNINGが空ということは、競合で弾かれた行であるということ
		const inserted: Song[] = [];
		results.forEach((res, i) => {
			if (res.rows.length > 0) inserted.push(created[i]);
			else {
				skipped.push({
					title: fresh[i].title,
					artist: fresh[i].artist,
					existingId: null,
				});
			}
		});

		// hot スナップショットをstaleにする
		if (c.env.HOT && inserted.length > 0) {
			c.executionCtx.waitUntil(markSnapshotStale(c.env.HOT));
		}

		return c.json({ created: inserted, skipped }, 201);
	},
);

// GET /songs
// 		?title= 	曲の前方一致
// 		&artist= 	アーティスト名の前方一致
// 		&limit= 	最大件数(1~200)
// 		&page= 		ページ番号(1~)
// titleかartistの少なくとも一方は必須
app.get(
	'/songs',
	zValidator('query', searchQuerySchema, onInvalid),
	async (c) => {
		// 曲を検索する
		// このエンドポイントでは、キャッシュに登録されていない場合にマスターDBから取得してキャッシュに登録して値を返すようにする
		const q = c.req.valid('query');

		// エッジキャッシュ
		// 正規化キーで組み直す。?title=よる, ?title=ヨル, ?title=ﾖﾙを同じキャッシュキーにする
		const cacheKey = new Request(
			`${new URL(c.req.url).origin}/__songs?${cacheKeyOf(
				normalizeKey(q.title ?? ''),
				normalizeKey(q.artist ?? ''),
				q.limit,
				q.page,
			)}`,
		);
		const edge = (caches as unknown as { default: Cache }).default;
		const cached = await edge.match(cacheKey);
		if (cached) {
			const hit = new Response(cached.body, cached);
			hit.headers.set('X-Cache', 'HIT');
			return hit;
		}

		const conn = c.get('db');
		let built = buildSearchQuery(q);

		// 記号だけの検索後などは検索せずに空配列を返す
		if (built.empty) {
			return c.json({
				items: [],
				page: q.page,
				limit: q.limit,
				hasMore: false,
				refine: false,
			});
		}

		let rows = await fetchRows(conn, built);

		// 振り分けが外れた時のため、空振りしたときだけ逆の列で引き直す
		if (rows.length === 0 && q.page === 1 && built.titleColumn) {
			built = buildSearchQuery({
				...q,
				forceTitleColumn:
					built.titleColumn === 'reading_key'
						? 'title_key'
						: 'reading_key',
			});
			rows = await fetchRows(conn, built);
		}

		const hasMore = rows.length > built.limit;
		const res = c.json({
			items: rows.slice(0, built.limit).map(toSong),
			page: q.page,
			limit: built.limit,
			hasMore,
			refine: hasMore && built.atWindowEnd,
		});
		res.headers.set('Cache-Control', 'public, max-age=300');
		res.headers.set('X-Cache', 'MISS');
		c.executionCtx.waitUntil(edge.put(cacheKey, res.clone()));
		return res;
	},
);

// GET /songs/suggest
// complete=trueならばスナップショットがマスタと一致している状態
// complete=falseならば、あくまで候補であり、GET /songsで確定する。
// 候補であることは断りを入れる。
app.get(
	'/songs/suggest',
	zValidator('query', suggestQuerySchema, onInvalid),
	async (c) => {
		if (!c.env.HOT) {
			return c.json({
				items: [],
				complete: false,
				source: 'none' as const,
			});
		}
		const ix = await loadHotIndex(c.env.HOT);
		if (!ix) {
			return c.json({
				items: [],
				complete: false,
				source: 'none' as const,
			});
		}
		const r = searchHot(ix, c.req.valid('query'));
		return c.json({
			items: r.items,
			complete: r.complete,
			source: 'hot' as const,
		});
	},
);

// hotインデックスのスナップショットを再構築する
// マスタから最大SNAPSHOT_MAX曲を選んでKVに1個ぼblobとして保存する。
// 1日1曲なら、20,000×30 = 60万行/月で、十分に無料枠で済む
const SNAPSHOT_MAX = 20000;
async function rebuildSnapshot(env: Bindings): Promise<void> {
	if (!env.HOT) return;

	const rs = await db(env).execute({
		sql: `SELECT id, title, reading_title, artist, created_at FROM songs ORDER BY reading_key, id LIMIT ?`,
		args: [SNAPSHOT_MAX + 1], // 1件多く取って、全件かどうかを判定する
	});

	const all = rs.rows as unknown as Record<string, string | number>[];
	const coversAll = all.length <= SNAPSHOT_MAX;
	const rows: Snapshot['rows'] = all
		.slice(0, SNAPSHOT_MAX)
		.map((r) => [
			String(r.id),
			String(r.title),
			String(r.reading_title),
			String(r.artist),
			new Date(Number(r.created_at)).toISOString(),
		]);

	await putSnapshot(env.HOT, rows, coversAll);
}

// 関数群
async function fetchRows(conn: Client, built: BuiltQuery) {
	const rs = await conn.execute({ sql: built.sql, args: built.args });
	return rs.rows as unknown as Record<string, string | number>[];
}

function toSong(r: Record<string, string | number>): Song {
	return {
		id: String(r.id),
		title: String(r.title),
		readingTitle: String(r.reading_title),
		artist: String(r.artist),
		createdAt: new Date(Number(r.created_at)).toISOString(),
	};
}

app.route('/', streamers);

// 視聴者向け(認証なし)
app.route('/', publicRoutes);

// OBSドックのペアリング
app.route('/', pairing);

export { PairingDO };

export default {
	fetch: app.fetch,
	scheduled: (_event: unknown, env: Bindings, ctx: ExecutionContext) => {
		ctx.waitUntil(rebuildSnapshot(env));
		ctx.waitUntil(
			purgeSyncedPerformances(
				createClient({
					url: env.TURSO_DATABASE_URL,
					authToken: env.TURSO_AUTH_TOKEN,
				}),
			).then(() => undefined),
		);
	},
};

// export default app;
