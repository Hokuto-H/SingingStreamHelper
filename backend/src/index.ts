import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { v7 as uuidv7 } from 'uuid';
import { createClient, LibsqlError, Client } from '@libsql/client';
import { SongReqSchema, SongRes } from './types';

export type Bindings = {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
};

export type Variables = {
	db: Client;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('*', async (c, next) => {
	if (!c.get('db')) {
		const db = createClient({
			url: c.env.TURSO_DATABASE_URL,
			authToken: c.env.TURSO_AUTH_TOKEN,
		});
		c.set('db', db);
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

app.post('/songs', zValidator('json', SongReqSchema), async (c) => {
	// 曲をマスターDBに登録する
	const reqData = await c.req.valid('json');
	const db = c.get('db');

	if (
		reqData.title === null ||
		reqData.title === undefined ||
		reqData.artist === null ||
		reqData.artist === undefined
	) {
		return c.json({ error: '曲名とアーティスト名は必須です' }, 400);
	}

	const song: SongRes = {
		id: uuidv7(),
		title: reqData.title,
		artist: reqData.artist,
		readingTitle: reqData.readingTitle,
		createdAt: new Date().toISOString(),
	};

	// バックエンドのキャッシュ(SongBackCache型)に登録する

	await db.execute({
		sql: 'INSERT INTO songs (id, title, artist, readingTitle, createdAt) VALUES (?, ?, ?, ?, ?)',
		args: [
			song.id,
			song.title,
			song.artist,
			song.readingTitle,
			song.createdAt,
		],
	});

	return c.json(song, 201);
});

export default app;
