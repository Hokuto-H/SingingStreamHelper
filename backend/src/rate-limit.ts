// レート制限

import type { Context, Next } from 'hono';

export interface RateRule {
	windowMs: number;
	limit: number;
	message: string;
}

export const RULES: Record<string, RateRule> = {
	'POST /streamers': {
		windowMs: 60 * 60 * 1000,
		limit: 10,
		message:
			'登録の試行回数が多すぎます。しばらく待ってからお試しください。',
	},
	'POST /streamers/recover/start': {
		windowMs: 60 * 60 * 1000,
		limit: 10,
		message:
			'復旧の試行回数が多すぎます。しばらく待ってからお試しください。',
	},
	'POST /pair/start': {
		windowMs: 60 * 60 * 1000,
		limit: 20,
		message:
			'接続コードの発行が多すぎます。しばらく待ってからお試しください。',
	},
	'POST /pair/confirm': {
		windowMs: 60 * 60 * 1000,
		limit: 300,
		message: '曲の登録が多すぎます。しばらく待ってからお試しください。',
	},
};

// カウンタ
interface Bucket {
	count: number;
	resetAt: number;
}

const MAX_KEYS = 5000;
const buckets = new Map<string, Bucket>();

function evict(now: number): void {
	for (const [k, b] of buckets) {
		if (b.resetAt <= now) buckets.delete(k);
	}
	if (buckets.size <= MAX_KEYS) return;
	const over = buckets.size - MAX_KEYS;
	let i = 0;
	for (const k of buckets.keys()) {
		if (i++ >= over) break;
		buckets.delete(k);
	}
}

export interface RateResult {
	ok: boolean;
	remaining: number;
	resetAt: number;
}

export function hit(key: string, rule: RateRule, now = Date.now()): RateResult {
	evict(now);
	const b = buckets.get(key);
	if (!b || b.resetAt <= now) {
		const fresh = { count: 1, resetAt: now + rule.windowMs };
		buckets.set(key, fresh);
		return { ok: true, remaining: rule.limit - 1, resetAt: fresh.resetAt };
	}
	b.count += 1;
	return {
		ok: b.count <= rule.limit,
		remaining: Math.max(0, rule.limit - b.count),
		resetAt: b.resetAt,
	};
}

export function resetAll(): void {
	buckets.clear();
}

// 呼び元の識別

function callerKey(c: Context): string {
	return c.req.header('cf-connecting-ip') ?? 'local';
}

type Env = { Bindings: { RATE_LIMIT_DISABLED?: string } };

export async function rateLimit(
	c: Context<Env>,
	next: Next,
): Promise<Response | void> {
	if (c.req.method === 'OPTIONS') return next();

	if (String(c.env?.RATE_LIMIT_DISABLED ?? '') === '1') return next();

	const path = new URL(c.req.url).pathname;
	const rule = RULES[`${c.req.method} ${path}`];
	if (!rule) return next();

	const r = hit(`${c.req.method} ${path}|${callerKey(c)}`, rule);
	if (r.ok) return next();

	const retryAfter = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
	return c.json(
		{ error: 'too many requests', message: rule.message, retryAfter },
		429,
		{
			'retry-after': String(retryAfter),
			'cache-control': 'no-store',
		},
	);
}
