// 視聴者向けのエンドポイント

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Client } from '@libsql/client/web';

import {
	parseHistoryRows,
	parseRepertoireRows,
	parseVisibility,
	toPublicHistory,
	toPublicRepertoire,
} from './sheet-rows';
import {
	SheetsError,
	batchReadRanges,
	quoteSheet,
	type SheetsEnv,
} from './sheets';
import { SETTINGS_SHEET, publicListSchema } from './streamer-schema';

type Bindings = SheetsEnv & {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
};

type Variables = { db: Client };

export const publicRoutes = new Hono<{
	Bindings: Bindings;
	Variables: Variables;
}>();

const PUBLIC_CACHE_SECONDS = 60;

interface PublicStreamerRow {
	id: string;
	display_name: string | null;
	spreadsheet_id: string;
	repertoire_sheet: string;
	history_sheet: string;
}

async function findPublicStreamer(
	db: Client,
	id: string,
): Promise<PublicStreamerRow | null> {
	const rs = await db.execute({
		sql: `SELECT id, display_name, spreadsheet_id, repertoire_sheet, history_sheet FROM streamers WHERE id = ? AND is_public = 1`,
		args: [id],
	});
	return (rs.rows[0] as unknown as PublicStreamerRow | undefined) ?? null;
}

// タブが無いときは空を返す
async function readWithSettings(
	env: Bindings,
	spreadsheetId: string,
	a1: string,
): Promise<{ flags: ReturnType<typeof parseVisibility>; values: string[][] }> {
	try {
		const [settings, values] = await batchReadRanges(env, spreadsheetId, [
			`${quoteSheet(SETTINGS_SHEET)}!A2:B`,
			a1,
		]);
		return { flags: parseVisibility(settings ?? []), values: values ?? [] };
	} catch (e) {
		if (
			e instanceof SheetsError &&
			(e.status === 400 || e.status === 404)
		) {
			return { flags: parseVisibility([]), values: [] };
		}
		throw e;
	}
}

async function cached(
	request: Request,
	waitUntil: (p: Promise<unknown>) => void,
	build: () => Promise<unknown>,
): Promise<Response> {
	const cache = caches.default;
	const hit = await cache.match(request);
	if (hit) return hit;

	const res = new Response(JSON.stringify(await build()), {
		headers: {
			'content-type': 'application/json; charset=UTF-8',
			'cache-control': `public, max-age=${PUBLIC_CACHE_SECONDS}, s-maxage=${PUBLIC_CACHE_SECONDS}`,
		},
	});
	waitUntil(cache.put(request, res.clone()));
	return res;
}

// GET /public/streamers/:id プロフィール
publicRoutes.get('/public/streamers/:id', async (c) => {
	const row = await findPublicStreamer(c.get('db'), c.req.param('id'));
	if (!row) return c.json({ error: 'not found' }, 404);

	return cached(
		c.req.raw,
		(p) => c.executionCtx.waitUntil(p),
		async () => {
			const { flags, values } = await readWithSettings(
				c.env,
				row.spreadsheet_id,
				`${quoteSheet(row.repertoire_sheet)}!A2:K`,
			);
			return {
				streamer: { id: row.id, displayName: row.display_name },
				fields: flags,
				items: toPublicRepertoire(parseRepertoireRows(values), flags),
			};
		},
	);
});

publicRoutes.get('/public/streamers/:id/repertoire', async (c) => {
	const row = await findPublicStreamer(c.get('db'), c.req.param('id'));
	if (!row) return c.json({ error: 'not found' }, 404);

	return cached(
		c.req.raw,
		(p) => c.executionCtx.waitUntil(p),
		async () => {
			const { flags, values } = await readWithSettings(
				c.env,
				row.spreadsheet_id,
				`${quoteSheet(row.repertoire_sheet)}!A2:K`,
			);
			return {
				streamer: { id: row.id, displayName: row.display_name },
				fields: flags,
				items: toPublicRepertoire(parseRepertoireRows(values), flags),
			};
		},
	);
});

// GET /public/streamers/:id/hsitory 歌唱履歴
publicRoutes.get(
	'/public/streamers/:id/history',
	zValidator('query', publicListSchema),
	async (c) => {
		const row = await findPublicStreamer(c.get('db'), c.req.param('id'));
		if (!row) return c.json({ error: 'not found' }, 404);

		const { limit } = c.req.valid('query');
		return cached(
			c.req.raw,
			(p) => c.executionCtx.waitUntil(p),
			async () => {
				const { flags, values } = await readWithSettings(
					c.env,
					row.spreadsheet_id,
					`${quoteSheet(row.history_sheet)}!A2:E`,
				);
				return {
					streamer: { id: row.id, displayName: row.display_name },
					fields: flags,
					items: toPublicHistory(
						parseHistoryRows(values, limit),
						flags,
					),
				};
			},
		);
	},
);
