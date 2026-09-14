// OBSドックのペアリング

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Client } from '@libsql/client/web';

import { issueTokenFor, type Session } from './session';
import { requireFullScope, requireStreamer } from './streamers';
import type { SheetsEnv } from './sheets';
import {
	HUMAN_CODE_ALPHABET,
	PAIR_CODE_LENGTH,
	pairClaimSchema,
	pairConfirmSchema,
	pairStatusSchema,
} from './streamer-schema';

// 定数
const PAIR_TTL_MS = 10 * 60 * 1000; // コードの有効期限
const MAX_CLAIMS = 5;
const MAX_PIN_ATTEMPTS = 3;

// Durable Object

interface PairClaim {
	streamerId: string;
	displayName: string | null;
	pin: string;
	at: number;
}

interface PairRecord {
	handleHash: string;
	expiresAt: number;
	claims: PairClaim[];
	attempts: number;
}

const REC_KEY = 'rec';

export class PairingDO {
	constructor(
		private state: DurableObjectState,
		_env: unknown,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const body = (await request.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		switch (url.pathname) {
			case '/create':
				return this.create(String(body.handleHash ?? ''));
			case '/claim':
				return this.claim(
					String(body.streamerId ?? ''),
					body.displayName == null ? null : String(body.displayName),
				);
			case '/confirm':
				return this.confirm(
					String(body.handleHash ?? ''),
					String(body.pin ?? ''),
				);
			case '/status':
				return this.status(String(body.handleHash ?? ''));
			default:
				return json({ error: 'not found' }, 404);
		}
	}

	private async read(): Promise<PairRecord | null> {
		const rec = await this.state.storage.get<PairRecord>(REC_KEY);
		if (!rec) return null;
		if (rec.expiresAt <= Date.now()) {
			await this.state.storage.delete(REC_KEY);
			return null;
		}
		return rec;
	}

	// ドックが呼ぶ
	private async create(handleHash: string): Promise<Response> {
		if (!handleHash) return json({ error: 'bad request' }, 400);
		if (await this.read()) return json({ error: 'code in use' }, 409);

		const expiresAt = Date.now() + PAIR_TTL_MS;
		await this.state.storage.put<PairRecord>(REC_KEY, {
			handleHash,
			expiresAt,
			claims: [],
			attempts: 0,
		});
		await this.state.storage.setAlarm(expiresAt + 1000);
		return json({ expiresAt });
	}

	// ログイン済みのブラウザがコードを入力した際に呼ぶ
	private async claim(
		streamerId: string,
		displayName: string | null,
	): Promise<Response> {
		const rec = await this.read();
		if (!rec) return json({ error: 'expired' }, 404);

		rec.claims = rec.claims.filter((c) => c.streamerId !== streamerId);
		if (rec.claims.length >= MAX_CLAIMS)
			return json({ error: 'too many' }, 429);

		let pin = randomDigits(3);
		for (let i = 0; i < 50 && rec.claims.some((c) => c.pin === pin); i++) {
			pin = randomDigits(3);
		}
		rec.claims.push({ streamerId, displayName, pin, at: Date.now() });
		await this.state.storage.put(REC_KEY, rec);
		return json({ pin, expiresAt: rec.expiresAt });
	}

	// ドックがhandleと配信者のpinを持ってくる
	private async confirm(handleHash: string, pin: string): Promise<Response> {
		const rec = await this.read();
		if (!rec) return json({ error: 'expired' }, 404);
		if (!timingSafeEqualHex(handleHash, rec.handleHash)) {
			return json({ error: 'bad request' }, 403);
		}

		const hit = rec.claims.find((c) => c.pin === pin);
		if (!hit) {
			rec.attempts += 1;
			if (rec.attempts >= MAX_PIN_ATTEMPTS) {
				await this.state.storage.deleteAll();
				return json({ error: 'too many attempts' }, 403);
			}
			await this.state.storage.put(REC_KEY, rec);
			return json(
				{
					error: 'bad pin',
					remaining: MAX_PIN_ATTEMPTS - rec.attempts,
				},
				403,
			);
		}

		await this.state.storage.deleteAll();
		return json({
			streamerId: hit.streamerId,
			displayName: hit.displayName,
		});
	}

	// ドックが誰かがコードを入力したか確認するために呼ぶ
	private async status(handleHash: string): Promise<Response> {
		const rec = await this.read();
		if (!rec) return json({ error: 'expired' }, 404);
		if (!timingSafeEqualHex(handleHash, rec.handleHash)) {
			return json({ error: 'bad handle' }, 403);
		}
		return json({ claims: rec.claims.length, expiresAt: rec.expiresAt });
	}

	async alarm(): Promise<void> {
		await this.state.storage.deleteAll();
	}
}

// ルート
type Bindings = SheetsEnv & {
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
	PAIRING: DurableObjectNamespace;
};

type Variables = { db: Client; session: Session };

export const pairing = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// codeから Durable Objectのインスタンスを呼び出す
function doFor(env: Bindings, code: string) {
	return env.PAIRING.get(env.PAIRING.idFromName(code));
}

async function callDO(
	env: Bindings,
	code: string,
	path: string,
	body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const res = await doFor(env, code).fetch(
		new Request(`https://pairing.internal${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
	return {
		status: res.status,
		data: (await res.json()) as Record<string, unknown>,
	};
}

// ドックが呼ぶ
// POST /pair/start
pairing.post('/pair/start', async (c) => {
	for (let i = 0; i < 5; i++) {
		const code = randomCode();
		const handle = randomHandle();
		const r = await callDO(c.env, code, '/create', {
			handleHash: await sha256Hex(handle),
		});
		if (r.status === 409) continue;
		if (r.status !== 200)
			return c.json({ error: 'pairing unavailable' }, 503);
		return c.json(
			{
				code: formatCode(code),
				handle,
				expiresAt: new Date(Number(r.data.expiresAt)).toISOString(),
				message:
					'この接続コードをブラウザの連携画面に入力してください。',
			},
			201,
		);
	}
	return c.json({ error: 'pairing unavailable' }, 503);
});

// ブラウザでコードを入力する
// POST /pair/claim
pairing.post(
	'/pair/claim',
	requireStreamer,
	requireFullScope,
	zValidator('json', pairClaimSchema),
	async (c) => {
		const s = c.get('session');
		const code = c.req.valid('json').code;
		const r = await callDO(c.env, code, '/claim', {
			streamerId: s.streamerId,
			displayName: s.displayName,
		});
		if (r.status === 404) {
			return c.json(
				{
					error: 'expired',
					message: 'コードが異なるか、期限が切れています。',
				},
				404,
			);
		}
		if (r.status === 429) {
			return c.json(
				{
					error: 'too many',
					message: 'このコードへの連携要求が多すぎます。',
				},
				429,
			);
		}
		if (r.status !== 200)
			return c.json({ error: 'pairing unavailable' }, 503);
		return c.json({
			pin: r.data.pin,
			expiresAt: new Date(Number(r.data.expiresAt)).toISOString(),
			message: 'この3桁をOBSのドックに入力してください。',
		});
	},
);

// ドックがhandleとpinを持ってくる
// POST /pair/confirm
pairing.post(
	'/pair/confirm',
	zValidator('json', pairConfirmSchema),
	async (c) => {
		const input = c.req.valid('json');
		const r = await callDO(c.env, input.code, '/confirm', {
			handleHash: await sha256Hex(input.handle),
			pin: input.pin,
		});

		if (r.status === 404) {
			return c.json(
				{
					error: 'expired',
					message: '期限が切れています。やり直してください。',
				},
				404,
			);
		}
		if (r.status === 403) {
			if (r.data.error === 'too many attempts') {
				return c.json(
					{
						error: 'too many attempts',
						message:
							'確認番号を間違えすぎました。やり直してください。',
					},
					403,
				);
			}
			if (r.data.error === 'bad pin') {
				return c.json(
					{
						error: 'bad pin',
						remaining: r.data.remaining,
						message: '確認番号が違います。',
					},
					403,
				);
			}
			return c.json({ error: 'forbidden' }, 403);
		}
		if (r.status !== 200)
			return c.json({ error: 'pairing unavailable' }, 503);

		const issued = await issueTokenFor(
			c.get('db'),
			String(r.data.streamerId),
			'dock',
			'OBSドック (ペアリング)',
		);
		return c.json(
			{
				token: issued.token,
				scope: issued.scope,
				displayName: r.data.displayName ?? null,
				note: '再取得はできません。失った場合はペアリングをやり直してください。',
			},
			201,
		);
	},
);

// ドックが誰かがコードを入力したかを見る
pairing.post(
	'/pair/status',
	zValidator('json', pairStatusSchema),
	async (c) => {
		const input = c.req.valid('json');
		const r = await callDO(c.env, input.code, '/status', {
			handleHash: await sha256Hex(input.handle),
		});
		if (r.status === 404) return c.json({ error: 'expired' }, 404);
		if (r.status === 403) return c.json({ error: 'forbidden' }, 403);
		return c.json({
			claims: r.data.claims,
			expiresAt: new Date(Number(r.data.expiresAt)).toISOString(),
		});
	},
);

// helper関数
function json(o: unknown, status = 200): Response {
	return new Response(JSON.stringify(o), {
		status,
		headers: { 'content-type': 'application/json; charset=UTF-8' },
	});
}

function randomCode(): string {
	const bytes = new Uint8Array(PAIR_CODE_LENGTH);
	crypto.getRandomValues(bytes);
	return [...bytes]
		.map((b) => HUMAN_CODE_ALPHABET[b % HUMAN_CODE_ALPHABET.length])
		.join('');
}

function formatCode(code: string): string {
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function randomHandle(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomDigits(n: number): string {
	const bytes = new Uint32Array(n);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => String(b % 10)).join('');
}

async function sha256Hex(s: string): Promise<string> {
	const d = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(s),
	);
	return [...new Uint8Array(d)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++)
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
