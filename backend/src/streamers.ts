// 配信者とスプレッドシートの遣り取りをするルート
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { v7 as uuidv7 } from 'uuid';
import type { Client } from '@libsql/client/web';

import { bearerFrom, issueToken } from './auth';
import {
	parseHistoryRows,
	parseRepertoireRows,
	parseVisibility,
	settingsRows,
} from './sheet-rows';
import {
	invalidateStreamer,
	issueTokenFor,
	resolveSession,
	revokeAllDockTokens,
	revokeTokenByPrefix,
	saveSpreadsheetTitle,
	titleIsStale,
	type Session,
	type TokenScope,
} from './session';
import {
	SheetsError,
	appendRows,
	ensureSheets,
	extractSpreadsheetId,
	formatSheetDateTime,
	probeAccess,
	quoteSheet,
	escapeSheetText,
	readRange,
	updateRange,
	type SheetSpec,
	type SheetsEnv,
} from './sheets';
import {
	DEFAULT_PUBLIC_FIELDS,
	HISTORY_HEADER,
	HISTORY_SHEET,
	HISTORY_WRITE_RANGE,
	PUBLIC_FIELD_DEFS,
	HUMAN_CODE_ALPHABET,
	SETTINGS_HEADER,
	SETTINGS_SHEET,
	REPERTOIRE_HEADER,
	REPERTOIRE_SHEET,
	REPERTOIRE_WRITE_RANGE,
	addRepertoireSchema,
	createPerformancesSchema,
	publicFieldsInputSchema,
	repertoireFormulas,
	issueTokenSchema,
	listPerformancesSchema,
	loginSchema,
	normalizeHumanCode,
	updateStreamerSchema,
	recoverCompleteSchema,
	recoverStartSchema,
	registerStreamerSchema,
	type Streamer,
} from './streamer-schema';

type Bindings = SheetsEnv & {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
};

type Variables = {
	db: Client;
	session: Session;
};

export const streamers = new Hono<{
	Bindings: Bindings;
	Variables: Variables;
}>();

// 2つのタブの定義
function sheetSpecs(repertoire: string, history: string): SheetSpec[] {
	const f = repertoireFormulas(history);
	return [
		{
			title: repertoire,
			header: [...REPERTOIRE_HEADER],
			headerFormulas: { 9: f.singCount, 10: f.lastSungAt },
		},
		{ title: history, header: [...HISTORY_HEADER] },
		// 公開設定
		{
			title: SETTINGS_SHEET,
			header: [...SETTINGS_HEADER],
			rows: settingsRows(),
		},
	];
}

// RepertoireのJ1/K1に数式を書き直す
async function writeRepertoireFormulas(
	env: SheetsEnv,
	spreadsheetId: string,
	repertoireSheet: string,
	historySheet: string,
): Promise<void> {
	const f = repertoireFormulas(historySheet);
	await updateRange(env, spreadsheetId, `${quoteSheet(repertoireSheet)}!J1`, [
		[f.singCount, f.lastSungAt],
	]);
}

const RECOVERY_CELL = 'A1';
const RECOVERY_TTL_MS = 15 * 60 * 1000;

// 認証ミドルウェア

export async function requireStreamer(
	c: Context<{ Bindings: Bindings; Variables: Variables }>,
	next: () => Promise<void>,
) {
	const token = bearerFrom(c.req.header('authorization'));
	if (!token) {
		return c.json(
			{ error: 'unauthorized', message: 'トークンが必要です。' },
			401,
		);
	}

	const session = await resolveSession(c.get('db'), token, {
		waitUntil: (p) => c.executionCtx.waitUntil(p),
	});
	if (!session) {
		return c.json(
			{
				error: 'unauthorized',
				message: 'トークンが無効か失効しています。',
			},
			401,
		);
	}

	c.set('session', session);
	await next();
}

// scope="full"が必要な場合
export async function requireFullScope(
	c: Context<{ Bindings: Bindings; Variables: Variables }>,
	next: () => Promise<void>,
) {
	if (c.get('session').scope !== 'full') {
		return c.json(
			{
				error: 'forbidden',
				message:
					'この操作にはブラウザ用のトークンが必要です。ドック用のトークンでは実行できません。',
			},
			403,
		);
	}
	await next();
}

// POST /streamer 登録
streamers.post(
	'/streamers',
	zValidator('json', registerStreamerSchema),
	async (c) => {
		const input = c.req.valid('json');
		const db = c.get('db');

		const spreadsheetId = extractSpreadsheetId(input.spreadsheet);
		if (!spreadsheetId) {
			return c.json(
				{
					error: 'invalid spreadsheet',
					message:
						'スプレッドシートのURLかIDを正しく指定してください。',
				},
				400,
			);
		}

		// 所有権の確認
		// サービスアカウントでスプレッドシートにアクセスできるか確認する
		let info: { title: string; timeZone: string; sheetTitles: string[] };
		try {
			info = await probeAccess(c.env, spreadsheetId);
		} catch (e) {
			const status = e instanceof SheetsError ? e.status : 500;
			if (status === 403 || status === 404) {
				return c.json(
					{
						error: 'not shared',
						message:
							'スプレッドシートにアクセスできません。共有設定でサービスアカウントを「編集者」として追加してください。',
						shareWith: serviceAccountEmail(c.env),
					},
					403,
				);
			}
			throw e;
		}

		// すでに紐づいているか
		const existing = await db.execute({
			sql: `SELECT id FROM streamers WHERE spreadsheet_id = ?`,
			args: [spreadsheetId],
		});
		if (existing.rows.length > 0) {
			return c.json(
				{
					error: 'already registered',
					message:
						'このスプレッドシートは登録済みです。お持ちのトークンでログインするか、紛失した場合は復旧手続きを行ってください。',
					recoverPath: '/streamers/recover/start',
				},
				409,
			);
		}

		// 作成・トークン発行
		const now = Date.now();
		const id = uuidv7();
		const { token, hash: tokenHash } = await issueToken();

		await ensureSheets(
			c.env,
			spreadsheetId,
			sheetSpecs(input.repertoireSheet, input.historySheet),
		);

		// 登録
		// info.title, timeZone
		await db.batch(
			[
				{
					sql: `INSERT INTO streamers (id, spreadsheet_id, repertoire_sheet, history_sheet, timezone, spreadsheet_title, title_synced_at, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					args: [
						id,
						spreadsheetId,
						input.repertoireSheet,
						input.historySheet,
						info.timeZone,
						info.title,
						now,
						input.displayName ?? null,
						now,
						now,
					],
				},
				{
					sql: `INSERT INTO streamer_tokens (token_hash, streamer_id, scope, label, created_at) VALUES (?, ?, 'full', ?, ?)`,
					args: [tokenHash, id, '初回登録', now],
				},
			],
			'write',
		);

		return c.json(
			{
				streamer: toStreamer({
					streamerId: id,
					spreadsheetId,
					repertoireSheet: input.repertoireSheet,
					historySheet: input.historySheet,
					timezone: info.timeZone,
					spreadsheetTitle: info.title,
					titleSyncedAt: now,
					displayName: input.displayName ?? null,
					isPublic: false,
					streamerCreatedAt: now,
					scope: 'full',
					tokenHash,
					tokenLabel: '初回登録',
				}),
				token,
				scope: 'full' satisfies TokenScope,
				warning:
					'このトークンはこれ以降表示されません。安全な場所に保存してください。',
			},
			201,
		);
	},
);

// GET /me トークンから紐づけ

streamers.get('/me', requireStreamer, async (c) => {
	const s = c.get('session');
	refreshTitleIfStale(c, s);
	return c.json({
		streamer: toStreamer(s),
		scope: s.scope,
		tokenLabel: s.tokenLabel,
	});
});

// POST /auth/session ログイン部分の入口
streamers.post('/auth/session', zValidator('json', loginSchema), async (c) => {
	const session = await resolveSession(
		c.get('db'),
		c.req.valid('json').token,
		{
			waitUntil: (p) => c.executionCtx.waitUntil(p),
		},
	);
	if (!session) {
		return c.json(
			{
				error: 'unauthorized',
				message: 'トークンが無効か失効しています。',
			},
			401,
		);
	}
	refreshTitleIfStale(c, session);
	return c.json({
		streamer: toStreamer(session),
		scope: session.scope,
		tokenLabel: session.tokenLabel,
	});
});

// PATCH /me シート名や表示名の変更
streamers.patch(
	'/me',
	requireStreamer,
	requireFullScope,
	zValidator('json', updateStreamerSchema),
	async (c) => {
		const s = c.get('session');
		const input = c.req.valid('json');
		if (
			input.repertoireSheet === undefined &&
			input.historySheet === undefined &&
			input.displayName === undefined &&
			input.isPublic === undefined
		) {
			return c.json({ error: 'nothing to update.' }, 400);
		}

		const repertoire = input.repertoireSheet ?? s.repertoireSheet;
		const history = input.historySheet ?? s.historySheet;
		if (repertoire === history) {
			return c.json(
				{
					error: 'invalid',
					message: '2つのタブに同じ名前は指定できません。',
				},
				400,
			);
		}

		// タブを増やす
		if (
			input.repertoireSheet !== undefined ||
			input.historySheet !== undefined
		) {
			await ensureSheets(
				c.env,
				s.spreadsheetId,
				sheetSpecs(repertoire, history),
			);
			// Hisstoryタブの名前の変更とともにRepertoireの数式を修正する
			if (
				input.historySheet !== undefined &&
				input.historySheet !== s.historySheet
			) {
				await writeRepertoireFormulas(
					c.env,
					s.spreadsheetId,
					repertoire,
					history,
				);
			}
		}

		const sets: string[] = ['updated_at = ?'];
		const args: (string | number | null)[] = [Date.now()];
		if (input.repertoireSheet !== undefined) {
			sets.push('repertoire_sheet = ?');
			args.push(input.repertoireSheet);
		}
		if (input.historySheet !== undefined) {
			sets.push('history_sheet = ?');
			args.push(input.historySheet);
		}
		if (input.displayName !== undefined) {
			sets.push('display_name = ?');
			args.push(input.displayName);
		}
		if (input.isPublic !== undefined) {
			sets.push('is_public = ?');
			args.push(input.isPublic ? 1 : 0);
		}
		args.push(s.streamerId);

		await c.get('db').execute({
			sql: `UPDATE streamers SET ${sets.join(', ')} WHERE id = ?`,
			args,
		});
		invalidateStreamer(s.streamerId);

		return c.json({
			streamer: toStreamer({
				...s,
				repertoireSheet: repertoire,
				historySheet: history,
				isPublic: input.isPublic ?? s.isPublic,
				displayName:
					input.displayName === undefined
						? s.displayName
						: input.displayName,
			}),
		});
	},
);

// トークン管理
// GET /me/tokens
streamers.get('/me/tokens', requireStreamer, requireFullScope, async (c) => {
	const rs = await c.get('db').execute({
		sql: `SELECT token_hash, scope, label, created_at, last_used_at, revoked_at FROM streamer_tokens WHERE streamer_id = ? ORDER BY created_at DESC`,
		args: [c.get('session').streamerId],
	});
	const current = c.get('session').tokenHash;
	return c.json({
		tokens: (
			rs.rows as unknown as Record<string, string | number | null>[]
		).map((r) => ({
			id: String(r.token_hash).slice(0, 8),
			scope: r.scope === 'full' ? 'full' : 'dock',
			label: r.label,
			createdAt: new Date(Number(r.created_at)).toISOString(),
			lastUsedAt: r.last_used_at
				? new Date(Number(r.last_used_at)).toISOString()
				: null,
			isCurrent: String(r.token_hash) === current,
		})),
	});
});

// POST /me/tokens
streamers.post(
	'/me/tokens',
	requireStreamer,
	requireFullScope,
	zValidator('json', issueTokenSchema),
	async (c) => {
		const input = c.req.valid('json');
		const issued = await issueTokenFor(
			c.get('db'),
			c.get('session').streamerId,
			input.scope,
			input.label ?? null,
		);
		return c.json(
			{
				token: issued.token,
				id: issued.tokenHash.slice(0, 8),
				scope: issued.scope,
				warning:
					'このトークンはこれ以降表示されません。安全な場所に保存してください。',
			},
			201,
		);
	},
);

// POST /me/tokens/revoke-docks ドック用トークンをすべて失効させる
// 配信画面にペアリングコードが表示された場合などの停止用
// fullのトークンは失効しない
streamers.post(
	'/me/tokens/revoke-docks',
	requireStreamer,
	requireFullScope,
	async (c) => {
		const n = await revokeAllDockTokens(
			c.get('db'),
			c.get('session').streamerId,
		);
		return c.json({
			revoked: n,
			message:
				n === 0
					? '失効させるドック用トークンはありませんでした。'
					: 'OBSのドックは再度ペアリングが必要です。',
		});
	},
);

// DELETE /me/tokens/:id 失効
streamers.delete(
	'/me/tokens/:id',
	requireStreamer,
	requireFullScope,
	async (c) => {
		const prefix = c.req.param('id') ?? '';
		if (!/^[0-9a-f]{8}$/.test(prefix)) {
			return c.json({ error: 'invalid token id' }, 400);
		}
		const hashes = await revokeTokenByPrefix(
			c.get('db'),
			c.get('session').streamerId,
			prefix,
		);
		if (hashes.length === 0) return c.json({ error: 'not found' }, 404);
		return c.json({
			revoked: hashes.length,
			selfRevoked: hashes.includes(c.get('session').tokenHash),
			note: '他のサーバーに反映されるまでに60秒程度かかる場合があります。',
		});
	},
);

// 復旧
// コードの発行
// POST /streamers/recover/start
streamers.post(
	'/streamers/recover/start',
	zValidator('json', recoverStartSchema),
	async (c) => {
		const spreadsheetId = extractSpreadsheetId(
			c.req.valid('json').spreadsheet,
		);
		if (!spreadsheetId)
			return c.json({ error: 'invalid spreadsheet' }, 400);

		const rs = await c.get('db').execute({
			sql: `SELECT history_sheet FROM streamers WHERE spreadsheet_id = ?`,
			args: [spreadsheetId],
		});
		if (rs.rows.length === 0) {
			return c.json({ error: 'not registered' }, 404);
		}
		// 復旧コードはHistoryシートのA1に書いてもらう
		const sheetTitle = String(
			(rs.rows[0] as unknown as { history_sheet: string }).history_sheet,
		);

		const code = `SST-${randomCode()}`;
		const now = Date.now();
		await c.get('db').execute({
			sql: `INSERT INTO recovery_challenges (spreadsheet_id, code, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (spreadsheet_id) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, created_at = excluded.created_at`,
			args: [spreadsheetId, code, now + RECOVERY_TTL_MS, now],
		});

		return c.json({
			code,
			cell: `'${sheetTitle}'!${RECOVERY_CELL}`,
			message: `スプレッドシート「${sheetTitle}」の${RECOVERY_CELL}にこのコードを入力してから、復旧を完了してください。コードの有効期限は15分です。`,
			expiresAt: new Date(now + RECOVERY_TTL_MS).toISOString(),
		});
	},
);

// セルを読み、一致したらトークンを発行する
// セルに書き込めたことが本人確認ができたことになる
// PPST /streamers/recover/complete
streamers.post(
	'/streamers/recover/complete',
	zValidator('json', recoverCompleteSchema),
	async (c) => {
		const input = c.req.valid('json');
		const spreadsheetId = extractSpreadsheetId(input.spreadsheet);
		if (!spreadsheetId)
			return c.json({ error: 'invalid spreadsheet' }, 400);
		const db = c.get('db');

		const rs = await db.execute({
			sql: `SELECT s.id, s.history_sheet AS sheet_title, r.code, r.expires_at FROM streamers s JOIN recovery_challenges r ON r.spreadsheet_id = s.spreadsheet_id WHERE s.spreadsheet_id = ?`,
			args: [spreadsheetId],
		});
		const row = rs.rows[0] as unknown as
			| {
					id: string;
					sheet_title: string;
					code: string;
					expires_at: number;
			  }
			| undefined;
		if (!row) return c.json({ error: 'no pending challenge' }, 404);
		if (Number(row.expires_at) < Date.now()) {
			return c.json({ error: 'challenge expired' }, 410);
		}

		const values = await readRange(
			c.env,
			spreadsheetId,
			`'${row.sheet_title}'!${RECOVERY_CELL}`,
		);
		const cell = normalizeHumanCode(String(values[0]?.[0] ?? ''));
		if (cell !== normalizeHumanCode(row.code)) {
			return c.json(
				{
					error: 'code mismatch',
					message: `${RECOVERY_CELL} にコードが見つかりません。入力後しばらく待ってから再試行してください。`,
				},
				403,
			);
		}

		const now = Date.now();
		const { token, hash } = await issueToken();
		await db.batch(
			[
				{
					sql: `INSERT INTO streamer_tokens (token_hash, streamer_id, scope, label, created_at) VALUES (?, ?, 'full', ?, ?)`,
					args: [hash, row.id, input.label ?? '復旧', now],
				},
				{
					sql: `DELETE FROM recovery_challenges WHERE spreadsheet_id = ?`,
					args: [spreadsheetId],
				},
			],
			'write',
		);

		return c.json({
			token,
			warning:
				'このトークンはこれ以降表示されません。古いトークンが漏洩しているおそれがある場合は /me/tokensで失効させてください。',
			cleanup: `${RECOVERY_CELL}のコードは消して構いません。`,
		});
	},
);

// 歌唱履歴
const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000; // 24時間

// POST /me/performances
streamers.post(
	'/me/performances',
	requireStreamer,
	zValidator('json', createPerformancesSchema),
	async (c) => {
		const items = c.req.valid('json');
		const s = c.get('session');
		const db = c.get('db');
		const now = Date.now();

		const songIds = [...new Set(items.map((i) => i.songId))];
		const songsRs = await db.execute({
			sql: `SELECT id, title FROM songs WHERE id IN (${songIds.map(() => '?').join('. ')})`,
			args: songIds,
		});
		const songs = new Map(
			(songsRs.rows as unknown as Record<string, string>[]).map((r) => [
				String(r.id),
				String(r.title),
			]),
		);
		const missing = songIds.filter((id) => !songs.has(id));
		if (missing.length > 0) {
			return c.json(
				{
					error: 'unknown songId',
					message: '曲が見つかりません。',
					missing,
				},
				400,
			);
		}

		// performancesに記録
		const prepared = items.map((i) => ({
			...i,
			id: uuidv7(),
			sungAtMs: i.sungAt ? Date.parse(i.sungAt) : now,
		}));
		const results = await db.batch(
			prepared.map((p) => ({
				sql: `INSERT INTO performances (id, streamer_id, song_id, sung_at, stream_url, timestamp_sec, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (streamer_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
				args: [
					p.id,
					s.streamerId,
					p.songId,
					p.sungAtMs,
					p.streamUrl ?? null,
					p.timestampSec ?? null,
					p.clientId ?? null,
					now,
				],
			})),
			'write',
		);

		const accepted = prepared.filter((_, i) => results[i].rows.length > 0);
		const duplicated = prepared.filter(
			(_, i) => results[i].rows.length === 0,
		);

		// スプレッドシートに追記
		let synced = false;
		if (accepted.length > 0) {
			try {
				await appendRows(
					c.env,
					s.spreadsheetId,
					s.historySheet,
					HISTORY_WRITE_RANGE,
					accepted.map((p) => [
						escapeSheetText(p.songId),
						formatSheetDateTime(p.sungAtMs, s.timezone),
						escapeSheetText(songs.get(p.songId)!),
						escapeSheetText(p.streamUrl ?? ''),
						p.timestampSec ?? '',
					]),
				);
				synced = true;
				await db.execute({
					sql: `UPDATE performances SET synced_at = ? WHERE id IN (${accepted.map(() => '?').join(', ')})`,
					args: [Date.now(), ...accepted.map((p) => p.id)],
				});
			} catch {
				// synced: false
			}
		}

		return c.json(
			{
				created: accepted.map((p) => ({
					id: p.id,
					songId: p.songId,
					sungAt: new Date(p.sungAtMs).toISOString(),
					clientId: p.clientId ?? null,
				})),
				duplicated: duplicated.map((p) => ({
					songId: p.songId,
					clientId: p.clientId ?? null,
					reason: '同じ clientId で受付済みです(再送とみなしました)',
				})),
				synced,
			},
			201,
		);
	},
);

// GET /me/performances
streamers.get(
	'/me/performances',
	requireStreamer,
	zValidator('query', listPerformancesSchema),
	async (c) => {
		const { limit } = c.req.valid('query');
		const s = c.get('session');

		let values: string[][] = [];

		try {
			values = await readRange(
				c.env,
				s.spreadsheetId,
				`${quoteSheet(s.historySheet)}!A2:E`,
			);
		} catch (e) {
			if (
				!(e instanceof SheetsError) ||
				(e.status !== 400 && e.status !== 404)
			) {
				throw e;
			}
			// タブがない。空として扱う
		}

		const items = parseHistoryRows(values, limit);

		const pendingRs = await c.get('db').execute({
			sql: `SELECT id, song_id, sung_at, stream_url, timestamp_sec FROM performances WHERE streamer_id = ? AND synced_at IS NULL ORDER BY created_at DESC LIMIT 100`,
			args: [s.streamerId],
		});

		return c.json({
			items,
			sheet: s.historySheet,
			pending: (
				pendingRs.rows as unknown as Record<
					string,
					string | number | null
				>[]
			).map((r) => ({
				id: String(r.id),
				songId: String(r.song_id),
				sungAt: new Date(Number(r.sung_at)).toISOString(),
				streamUrl: r.stream_url === null ? null : String(r.stream_url),
				timestampSec:
					r.timestamp_sec === null ? null : Number(r.timestamp_sec),
			})),
		});
	},
);

// 同期済みの控えを削除
export async function purgeSyncedPerformances(
	db: Client,
	retentionMs: number = OUTBOX_RETENTION_MS,
): Promise<number> {
	const rs = await db.execute({
		sql: `DELETE FROM performances WHERE synced_at IS NOT NULL AND synced_at < ? RETURNING id`,
		args: [Date.now() - retentionMs],
	});
	return rs.rows.length;
}

// Repertoire
// GET /me/repertoire
streamers.get('/me/repertoire', requireStreamer, async (c) => {
	const s = c.get('session');
	let values: string[][];
	try {
		values = await readRange(
			c.env,
			s.spreadsheetId,
			`${quoteSheet(s.repertoireSheet)}!A2:K`,
		);
	} catch (e) {
		if (
			e instanceof SheetsError &&
			(e.status === 400 || e.status === 404)
		) {
			return c.json({ items: [], sheet: s.repertoireSheet });
		}
		throw e;
	}

	return c.json({
		items: parseRepertoireRows(values),
		sheet: s.repertoireSheet,
	});
});

// 持ち歌の追加
// POST /me/repertoire
streamers.post(
	'/me/repertoire',
	requireStreamer,
	requireFullScope,
	zValidator('json', addRepertoireSchema),
	async (c) => {
		const s = c.get('session');
		const items = c.req.valid('json');

		await ensureSheets(
			c.env,
			s.spreadsheetId,
			sheetSpecs(s.repertoireSheet, s.historySheet),
		);

		const existing = new Set(
			(
				await readRange(
					c.env,
					s.spreadsheetId,
					`${quoteSheet(s.repertoireSheet)}!A2:A`,
				)
			)
				.map((r) => (r[0] ?? '').trim())
				.filter(Boolean),
		);

		const fresh = items.filter((i) => !existing.has(i.songId));
		const skipped = items.filter((i) => existing.has(i.songId));

		if (fresh.length > 0) {
			await appendRows(
				c.env,
				s.spreadsheetId,
				s.repertoireSheet,
				REPERTOIRE_WRITE_RANGE,
				fresh.map((i) => [
					i.songId,
					i.title,
					i.artist,
					i.key,
					i.sourceUrl,
					i.lyricsUrl,
					i.status,
					i.tags,
					i.notes,
				]),
				'RAW',
			);
		}

		return c.json(
			{
				added: fresh.map((i) => i.songId),
				skipped: skipped.map((i) => ({
					songId: i.songId,
					reason: 'すでに持ち歌に登録済みです。',
				})),
			},
			fresh.length > 0 ? 201 : 200,
		);
	},
);

// 公開設定

// RepertoireのJ1/K1を今の定義で書き直す
// POST /me/sheets/repair
streamers.post(
	'/me/sheets/repair',
	requireStreamer,
	requireFullScope,
	async (c) => {
		const s = c.get('session');
		await ensureSheets(
			c.env,
			s.spreadsheetId,
			sheetSpecs(s.repertoireSheet, s.historySheet),
		);
		await writeRepertoireFormulas(
			c.env,
			s.spreadsheetId,
			s.repertoireSheet,
			s.historySheet,
		);
		return c.json({
			repaired: [`${s.repertoireSheet}!J1:K1`],
			historySheet: s.historySheet,
			message: '累計回数と最終歌唱日の数式を貼り直しました。',
		});
	},
);

// GET /me/public-fields
streamers.get('/me/public-fields', requireStreamer, async (c) => {
	const s = c.get('session');
	let values: string[][] = [];
	try {
		values = await readRange(
			c.env,
			s.spreadsheetId,
			`${quoteSheet(SETTINGS_SHEET)}!A2:B`,
		);
	} catch (e) {
		if (
			!(e instanceof SheetsError) ||
			(e.status !== 400 && e.status !== 404)
		)
			throw e;
		// タブがない場合は既定値を用いる
	}
	return c.json({
		fields: parseVisibility(values),
		defs: PUBLIC_FIELD_DEFS,
		sheet: SETTINGS_SHEET,
	});
});

// 公開設定の更新
// PUT /me/public-fields
streamers.put(
	'/me/public-fields',
	requireStreamer,
	requireFullScope,
	zValidator('json', publicFieldsInputSchema),
	async (c) => {
		const s = c.get('session');
		const input = c.req.valid('json');

		await ensureSheets(
			c.env,
			s.spreadsheetId,
			sheetSpecs(s.repertoireSheet, s.historySheet),
		);

		let current = DEFAULT_PUBLIC_FIELDS;
		try {
			current = parseVisibility(
				await readRange(
					c.env,
					s.spreadsheetId,
					`${quoteSheet(SETTINGS_SHEET)}!A2:B`,
				),
			);
		} catch (e) {
			if (
				!(e instanceof SheetsError) ||
				(e.status !== 400 && e.status !== 404)
			)
				throw e;
		}

		const next = { ...current };
		for (const d of PUBLIC_FIELD_DEFS) {
			const v = input[d.key];
			if (v !== undefined) next[d.key] = v;
		}

		await updateRange(
			c.env,
			s.spreadsheetId,
			`${quoteSheet(SETTINGS_SHEET)}!A2`,
			settingsRows(next),
		);

		return c.json({ fields: next, sheet: SETTINGS_SHEET });
	},
);

// スプレッドシートへの書き込みに失敗していた分を送り直す
// POST /me/resync
streamers.post('/me/resync', requireStreamer, async (c) => {
	const s = c.get('session');
	const db = c.get('db');
	const rs = await db.execute({
		sql: `SELECT p.id, p.song_id, p.sung_at, p.stream_url, p.timestamp_sec, s.title
			FROM performances p
			LEFT JOIN songs s ON s.id = p.song_id
			WHERE p.streamer_id = ? AND p.synced_at IS NULL
			ORDER BY p.created_at
			LIMIT 500`,
		args: [s.streamerId],
	});
	const rows = rs.rows as unknown as Record<string, string | number | null>[];
	if (rows.length === 0) return c.json({ resynced: 0 });

	await appendRows(
		c.env,
		s.spreadsheetId,
		s.historySheet,
		HISTORY_WRITE_RANGE,
		rows.map((r) => [
			escapeSheetText(String(r.song_id)),
			formatSheetDateTime(Number(r.sung_at), s.timezone),
			escapeSheetText(String(r.title ?? '')),
			escapeSheetText(String(r.stream_url ?? '')),
			r.timestamp_sec == null ? '' : Number(r.timestamp_sec),
		]),
	);
	await db.execute({
		sql: `UPDATE performances SET synced_at = ? WHERE id IN (${rows.map(() => '?').join(', ')})`,
		args: [Date.now(), ...rows.map((r) => String(r.id))],
	});
	return c.json({ resynced: rows.length });
});

// helper
function toStreamer(s: Session): Streamer {
	return {
		id: s.streamerId,
		spreadsheetId: s.spreadsheetId,
		spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${s.spreadsheetId}/edit`,
		spreadsheetTitle: s.spreadsheetTitle,
		repertoireSheet: s.repertoireSheet || REPERTOIRE_SHEET,
		historySheet: s.historySheet || HISTORY_SHEET,
		timezone: s.timezone,
		displayName: s.displayName,
		isPublic: s.isPublic,
		createdAt: new Date(s.streamerCreatedAt).toISOString(),
	};
}

// スプレッドシートのファイル名が古い場合は更新する
function refreshTitleIfStale(
	c: Context<{ Bindings: Bindings; Variables: Variables }>,
	s: Session,
): void {
	if (!titleIsStale(s.titleSyncedAt)) return;
	const db = c.get('db');
	c.executionCtx.waitUntil(
		(async () => {
			try {
				const { title, timeZone } = await probeAccess(
					c.env,
					s.spreadsheetId,
				);
				await saveSpreadsheetTitle(db, s.streamerId, title, timeZone);
			} catch {
				// 共有を外された場合など。放置しておく
			}
		})(),
	);
}

function serviceAccountEmail(env: SheetsEnv): string {
	try {
		return (
			JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
				client_email: string;
			}
		).client_email;
	} catch {
		return '(サービスアカウント未設定)';
	}
}

// 人が手で写せる長さや紛らわしい文字を除いたコード
function randomCode(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return [...bytes]
		.map((b) => HUMAN_CODE_ALPHABET[b % HUMAN_CODE_ALPHABET.length])
		.join('');
}
