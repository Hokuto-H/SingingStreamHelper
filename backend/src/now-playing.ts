// 今歌っている曲をオーバーレイに渡す

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Client } from '@libsql/client/web';

import type { Session } from './session';
import { requireStreamer, requireFullScope } from './streamers';
import type { SheetsEnv } from './sheets';
import {
	nowPlayingInputSchema,
	queueItemInputSchema,
	queueReorderSchema,
} from './streamer-schema';

export interface NowPlaying {
	title: string;
	artist: string | null;
	key: string | null;
	startedAt: number;
	seq: number;
}

type OverlayMessage =
	| {
			type: 'now-playing';
			song: NowPlaying | null;
			next: { title: string; artist: string | null } | null;
			serverTime: number;
	  }
	| { type: 'pong'; serverTime: number };

export interface QueueItem {
	id: string;
	songId: string | null;
	title: string;
	artist: string | null;
	key: string | null;
	note: string | null;
	addedAt: number;
}

const STATE_KEY = 'state';
const SEQ_KEY = 'seq';
const QUEUE_KEY = 'queue';
const QUEUE_REV_KEY = 'queueRev';
const MAX_QUEUE = 300;

const STALE_MS = 6 * 60 * 60 * 1000;

export class NowPlayingDO {
	private cached: NowPlaying | null | undefined;

	constructor(
		private state: DurableObjectState,
		_env: unknown,
	) {}

	// HTTP (ドック側)

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws') return this.accept(request);

		const body = (await request.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;

		if (url.pathname === '/set') {
			return json(
				await this.set(body as unknown as Omit<NowPlaying, 'seq'>),
			);
		}
		if (url.pathname === '/clear') {
			return json(await this.set(null));
		}
		if (url.pathname === '/get') {
			return json({ song: await this.read(), serverTime: Date.now() });
		}
		// セトリキュー
		if (url.pathname === '/queue/get') {
			return json(await this.queueView());
		}
		if (url.pathname === '/queue/add') {
			return this.queueAdd(body as Omit<QueueItem, 'id' | 'addedAt'>);
		}
		if (url.pathname === '/queue/reorder') {
			return this.queueReorder(
				Number((body as { rev?: unknown }).rev),
				((body as { ids?: unknown }).ids ?? []) as string[],
			);
		}
		if (url.pathname === '/queue/remove') {
			return this.queueRemove(
				String((body as { id?: unknown }).id ?? ''),
			);
		}
		if (url.pathname === '/queue/next') {
			return this.queueNext();
		}

		return json(
			{
				error: 'unknown path',
				path: url.pathname,
				known: ['/ws', '/set', '/clear', '/get'],
			},
			404,
		);
	}

	private async read(): Promise<NowPlaying | null> {
		if (this.cached === undefined) {
			this.cached =
				(await this.state.storage.get<NowPlaying>(STATE_KEY)) ?? null;
		}
		if (this.cached && Date.now() - this.cached.startedAt > STALE_MS) {
			this.cached = null;
			await this.state.storage.delete(STATE_KEY);
		}
		return this.cached;
	}

	private async set(
		song: Omit<NowPlaying, 'seq'> | null,
	): Promise<{ song: NowPlaying | null; listeners: number }> {
		const seq = ((await this.state.storage.get<number>(SEQ_KEY)) ?? 0) + 1;
		const next: NowPlaying | null = song ? { ...song, seq } : null;

		this.cached = next;
		if (next) {
			await this.state.storage.put(STATE_KEY, next);
			await this.state.storage.setAlarm(Date.now() + STALE_MS);
		} else {
			await this.state.storage.delete(STATE_KEY);
		}
		await this.state.storage.put(SEQ_KEY, seq);

		const listeners = await this.broadcastState();
		return { song: next, listeners };
	}

	// WebSocket (オーバーレイ側)
	private async accept(request: Request): Promise<Response> {
		if (request.headers.get('upgrade') !== 'websocket') {
			return json({ error: 'expected websocket' }, 426);
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		this.state.acceptWebSocket(server);

		// 接続時に現在の状態を送る
		const song = await this.read();
		const head = (await this.queue())[0];
		server.send(
			JSON.stringify({
				type: 'now-playing',
				song,
				next: head ? { title: head.title, artist: head.artist } : null,
				serverTime: Date.now(),
			} satisfies OverlayMessage),
		);

		return new Response(null, { status: 101, webSocket: client });
	}

	// オーバーレイからの受信
	async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message !== 'string') return;
		if (message.length > 200) return;
		let parsed: { type?: unknown };
		try {
			parsed = JSON.parse(message) as { type?: unknown };
		} catch {
			return;
		}
		if (parsed.type === 'ping') {
			ws.send(
				JSON.stringify({
					type: 'pong',
					serverTime: Date.now(),
				} satisfies OverlayMessage),
			);
		}
	}

	async wwebSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		try {
			ws.close(code === 1005 ? 1000 : code, reason);
		} catch {
			// 既に閉じている
		}
	}

	async webSocketError(): Promise<void> {
		// 何もしない
	}

	private async broadcastState(queueOverride?: QueueItem[]): Promise<number> {
		const head = (queueOverride ?? (await this.queue()))[0];
		return this.broadcast({
			type: 'now-playing',
			song: await this.read(),
			next: head ? { title: head.title, artist: head.artist } : null,
			serverTime: Date.now(),
		});
	}

	private broadcast(msg: OverlayMessage): number {
		const body = JSON.stringify(msg);
		let n = 0;
		for (const ws of this.state.getWebSockets()) {
			try {
				ws.send(body);
				n++;
			} catch {
				// 切れている
			}
		}
		return n;
	}

	// セトリキュー
	private async queue(): Promise<QueueItem[]> {
		return (await this.state.storage.get<QueueItem[]>(QUEUE_KEY)) ?? [];
	}

	private async queueRev(): Promise<number> {
		return (await this.state.storage.get<number>(QUEUE_REV_KEY)) ?? 0;
	}

	private async saveQueue(items: QueueItem[]): Promise<number> {
		const rev = (await this.queueRev()) + 1;
		await this.state.storage.put(QUEUE_KEY, items);
		await this.state.storage.put(QUEUE_REV_KEY, rev);
		await this.broadcastState(items);
		return rev;
	}

	private async queueView(): Promise<{ items: QueueItem[]; rev: number }> {
		return { items: await this.queue(), rev: await this.queueRev() };
	}

	private async queueAdd(
		input: Omit<QueueItem, 'id' | 'addedAt'>,
	): Promise<Response> {
		const items = await this.queue();
		if (items.length >= MAX_QUEUE) {
			return json({ error: 'queue is full', limit: MAX_QUEUE }, 409);
		}
		const item: QueueItem = {
			id: randomId(),
			songId: input.songId ?? null,
			title: String(input.title ?? ''),
			artist: input.artist ?? null,
			key: input.key ?? null,
			note: input.note ?? null,
			addedAt: Date.now(),
		};
		items.push(item);
		const rev = await this.saveQueue(items);
		return json({ item, items, rev });
	}

	private async queueReorder(rev: number, ids: string[]): Promise<Response> {
		const current = await this.queueRev();
		if (rev !== current) {
			return json(
				{ error: 'stale', rev: current, items: await this.queue() },
				409,
			);
		}
		const items = await this.queue();
		const byId = new Map(items.map((i) => [i.id, i]));

		const unknown = ids.filter((id) => !byId.has(id));
		if (unknown.length) {
			return json({ error: 'unknown ids', unknown }, 400);
		}
		const next = ids.map((id) => byId.get(id)!);
		const newRev = await this.saveQueue(next);
		return json({
			items: next,
			rev: newRev,
			removed: items.length - next.length,
		});
	}

	private async queueRemove(id: string): Promise<Response> {
		const items = await this.queue();
		const next = items.filter((i) => i.id !== id);
		if (next.length === items.length)
			return json({ error: 'not found' }, 404);
		const rev = await this.saveQueue(next);
		return json({ items: next, rev });
	}

	private async queueNext(): Promise<Response> {
		const items = await this.queue();
		const head = items[0];
		if (!head) return json({ error: 'queue empty' }, 409);
		const rest = items.slice(1);
		await this.state.storage.put(QUEUE_KEY, rest);
		await this.state.storage.put(
			QUEUE_REV_KEY,
			(await this.queueRev()) + 1,
		);

		const r = await this.set({
			title: head.title,
			artist: head.artist,
			key: head.key,
			startedAt: Date.now(),
		});
		return json({
			sung: head,
			song: r.song,
			listeners: r.listeners,
			items: rest,
			rev: await this.queueRev(),
		});
	}

	async alarm(): Promise<void> {
		const song = await this.state.storage.get<NowPlaying>(STATE_KEY);
		if (song && Date.now() - song.startedAt > STALE_MS) {
			await this.set(null);
		}
	}
}

// ルート
type Bindings = SheetsEnv & {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
	NOW_PLAYING: DurableObjectNamespace;
	PUBLIC_API_ORIGIN?: string;
};

type Variables = { db: Client; session: Session };

export const nowPlaying = new Hono<{
	Bindings: Bindings;
	Variables: Variables;
}>();

function doFor(env: Bindings, streamerId: string) {
	return env.NOW_PLAYING.get(env.NOW_PLAYING.idFromName(streamerId));
}

async function callDO(
	env: Bindings,
	streamerId: string,
	path: string,
	body?: unknown,
	allow?: number[],
): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await doFor(env, streamerId).fetch(
		new Request(`https://now-playing.internal${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		}),
	);
	const data = (await res.json()) as Record<string, unknown>;
	if (res.status !== 200 && !(allow ?? []).includes(res.status)) {
		throw new Error(
			`NowPlayingDO ${path} が ${res.status} を返しました: ${JSON.stringify(data)}` +
				` - ルート側が送るパスと NowPlayingDO.fetch()の分岐が一致しているか確認してください。`,
		);
	}
	return { status: res.status, data };
}

// 配信者側 (ドック)
// POST /me/now-playing
nowPlaying.post(
	'/me/now-playing',
	requireStreamer,
	zValidator('json', nowPlayingInputSchema),
	async (c) => {
		const s = c.get('session');
		const input = c.req.valid('json');
		const r = await callDO(c.env, s.streamerId, '/set', {
			title: input.title,
			artist: input.artist ?? null,
			key: input.key ?? null,
			startedAt: input.startedAt ?? Date.now(),
		});
		return c.json({ song: r.data.song, listeners: r.data.listeners });
	},
);

// DELETE /me/now-playing
nowPlaying.delete('/me/now-playing', requireStreamer, async (c) => {
	const r = await callDO(c.env, c.get('session').streamerId, '/clear');
	return c.json({ song: null, listeners: r.data.listeners });
});

// GET /me/now-playing
nowPlaying.get('/me/now-playing', requireStreamer, async (c) => {
	const r = await callDO(c.env, c.get('session').streamerId, '/get');
	return c.json(r.data);
});

// セトリキュー
// GET /me/queue
nowPlaying.get('/me/queue', requireStreamer, async (c) => {
	return c.json(
		(await callDO(c.env, c.get('session').streamerId, '/queue/get')).data,
	);
});

// POST /me/queue
nowPlaying.post(
	'/me/queue',
	requireStreamer,
	zValidator('json', queueItemInputSchema),
	async (c) => {
		const i = c.req.valid('json');
		const r = await callDO(
			c.env,
			c.get('session').streamerId,
			'/queue/add',
			{
				songId: i.songId ?? null,
				title: i.title,
				artist: i.artist ?? null,
				key: i.key ?? null,
				note: i.note ?? null,
			},
		);
		return c.json(r.data, 201);
	},
);

// 並び替え
// PUT /me/queue
nowPlaying.put(
	'/me/queue',
	requireStreamer,
	zValidator('json', queueReorderSchema),
	async (c) => {
		const { rev, ids } = c.req.valid('json');
		const r = await callDO(
			c.env,
			c.get('session').streamerId,
			'/queue/reorder',
			{ rev, ids },
			[200, 400, 409],
		);
		return c.json(r.data, r.status as 200 | 400 | 409);
	},
);

// 1曲外す
// DELETE /me/queue/:id
nowPlaying.delete('/me/queue/:id', requireStreamer, async (c) => {
	const r = await callDO(
		c.env,
		c.get('session').streamerId,
		'/queue/remove',
		{ id: c.req.param('id') },
		[200, 404],
	);
	return c.json(r.data, r.status as 200 | 404);
});

// 次の曲にする
// POST /me/queue/next
nowPlaying.post('/me/queue/next', requireStreamer, async (c) => {
	const r = await callDO(
		c.env,
		c.get('session').streamerId,
		'/queue/next',
		{},
		[200, 409],
	);
	return c.json(r.data, r.status as 200 | 409);
});

// オーバーレイの鍵
// GET /me/overlay
nowPlaying.get('/me/overlay', requireStreamer, requireFullScope, async (c) => {
	const s = c.get('session');
	const key = await ensureOverlayKey(c.get('db'), s.streamerId);
	return c.json({
		overlayKey: key,
		url: overlayUrl(c.env, c.req.url, key),
		hint: 'OBSのブラウザソースにこのURLを設定してください',
	});
});

// POST /me/overlay-key/rotate
nowPlaying.post(
	'/me/overlay-key/rotate',
	requireStreamer,
	requireFullScope,
	async (c) => {
		const s = c.get('session');
		const key = randomKey();
		await c.get('db').execute({
			sql: `UPDATE streamers SET overlay_key = ?, updated_at = ? WHERE id = ?`,
			args: [key, Date.now(), s.streamerId],
		});
		return c.json({
			overlayKey: key,
			url: overlayUrl(c.env, c.req.url, key),
			warning:
				'以前のURLは無効になりました。OBSのブラウザソースを更新してください。',
		});
	},
);

function overlayUrl(env: Bindings, requestUrl: string, key: string): string {
	const origin =
		(env.PUBLIC_API_ORIGIN ?? '').replace(/\/+$/, '') ||
		new URL(requestUrl).origin;
	return `${origin}/overlay?key=${key}`;
}

async function ensureOverlayKey(
	db: Client,
	streamerId: string,
): Promise<string> {
	const got = await db.execute({
		sql: `SELECT overlay_key FROM streamers WHERE id = ?`,
		args: [streamerId],
	});
	const existing = got.rows[0]?.overlay_key;
	if (typeof existing === 'string' && existing) return existing;

	const key = randomKey();
	await db.execute({
		sql: `UPDATE streamers SET overlay_key = ?, updated_at = ? WHERE id = ?`,
		args: [key, Date.now(), streamerId],
	});
	return key;
}

async function streamerByOverlayKey(
	db: Client,
	key: string,
): Promise<string | null> {
	if (!key || key.length < 20 || key.length > 100) return null;
	const got = await db.execute({
		sql: `SELECT id FROM streamers WHERE overlay_key = ?`,
		args: [key],
	});
	const id = got.rows[0]?.id;
	return typeof id === 'string' ? id : null;
}

// オーバーレイ側
// GET /overlay/ws
nowPlaying.get('/overlay/ws', async (c) => {
	if (c.req.header('upgrade') !== 'websocket') {
		return c.json({ error: 'expected websocket' }, 426);
	}
	const streamerId = await streamerByOverlayKey(
		c.get('db'),
		c.req.query('key') ?? '',
	);

	if (!streamerId) return c.json({ error: 'not found' }, 404);

	return doFor(c.env, streamerId).fetch(
		new Request('https://now-playing.internal/ws', {
			headers: { upgrade: 'websocket' },
		}),
	);
});

// WebSocketが張れない時
// GET /overlay/now-playing
nowPlaying.get('/overlay/now-playing', async (c) => {
	const streamerId = await streamerByOverlayKey(
		c.get('db'),
		c.req.query('key') ?? '',
	);
	if (!streamerId) return c.json({ error: 'not found' }, 404);
	const r = await callDO(c.env, streamerId, '/get');
	c.header('cache-control', 'no-store');
	return c.json(r.data);
});

// helper関数
function json(o: unknown, status = 200): Response {
	return new Response(JSON.stringify(o), {
		status,
		headers: { 'content-type': 'application/json; charset=UTF-8' },
	});
}

function randomId(): string {
	const b = new Uint8Array(8);
	crypto.getRandomValues(b);
	return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function randomKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
