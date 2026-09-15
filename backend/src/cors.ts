// CORS

import type { Context, Next } from 'hono';

const MAX_AGE = 600;

const ALLOW_HEADERS = 'authorization, content-type';
const ALLOW_METHODS = 'GET, POST, PATCH, PUT, DELETE, OPTIONS';

export function parseAllowedOrigins(raw: string | undefined): string[] {
	return String(raw ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

// オリジンが一覧に載っているか
export function originAllowed(
	origin: string,
	allowed: readonly string[],
): boolean {
	if (!origin) return false;
	for (const pattern of allowed) {
		if (pattern === origin) return true;
		const star = pattern.indexOf('://*.');
		if (star < 0) continue;
		const scheme = pattern.slice(0, star + 3);
		const suffix = pattern.slice(star + 5);
		if (suffix.split('.').length < 3) continue;
		if (!origin.startsWith(scheme)) continue;
		const host = origin.slice(scheme.length);
		if (!host.endsWith('.' + suffix)) continue;
		const label = host.slice(0, host.length - suffix.length - 1);
		if (label && !label.includes('/') && !label.includes('.')) return true;
	}
	return false;
}

function isPublicCacheable(path: string): boolean {
	return path.startsWith('/public/');
}

type Env = { Bindings: { ALLOWED_ORIGINS?: string } };

export async function cors(
	c: Context<Env>,
	next: Next,
): Promise<Response | void> {
	const origin = c.req.header('origin') ?? '';
	const allowed = parseAllowedOrigins(c.env?.ALLOWED_ORIGINS);
	const ok = originAllowed(origin, allowed);

	// preflight を処理する
	if (
		c.req.method === 'OPTIONS' &&
		c.req.header('access-control-request-method')
	) {
		const pub = isPublicCacheable(new URL(c.req.url).pathname);
		const h = new Headers(
			pub ? {} : { vary: 'Origin, Access-Control-Request-Headers' },
		);
		if (pub || ok) {
			h.set('access-control-allow-origin', pub ? '*' : origin);
			h.set('access-control-allow-methods', ALLOW_METHODS);
			h.set('access-control-allow-headers', ALLOW_HEADERS);
			h.set('access-control-max-age', String(MAX_AGE));
		}
		return new Response(null, { status: 204, headers: h });
	}

	await next();

	if (c.res.status === 101 || (c.res as { webSocket?: unknown }).webSocket) {
		return;
	}

	const headers = new Headers(c.res.headers);

	if (isPublicCacheable(new URL(c.req.url).pathname)) {
		headers.set('access-control-allow-origin', '*');
	} else {
		appendVary(headers, 'Origin');
		if (ok) headers.set('access-control-allow-origin', origin);
	}

	c.res = new Response(c.res.body, {
		status: c.res.status,
		statusText: c.res.statusText,
		headers,
	});
}

function appendVary(headers: Headers, value: string): void {
	const cur = headers.get('vary');
	if (!cur) {
		headers.set('vary', value);
		return;
	}
	const has = cur
		.split('.')
		.map((s) => s.trim().toLowerCase())
		.includes(value.toLowerCase());
	if (!has) headers.set('vary', `${cur}, ${value}`);
}
