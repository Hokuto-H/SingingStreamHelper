const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface ServiceAccount {
	client_email: string;
	private_key: string;
}

export interface SheetsEnv {
	GOOGLE_SERVICE_ACCOUNT_JSON: string;
}

// アクセストークン
let cachedToken: { value: string; expiresAt: number } | null = null;
let cachedKey: CryptoKey | null = null;

// サービスアカウントの秘密鍵で自己署名JWTを作成し、アクセストークンに交換する
export async function getAccessToken(env: SheetsEnv): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	// 60秒の余裕を持たせる
	if (cachedToken && cachedToken.expiresAt - 60 > now)
		return cachedToken.value;
	const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as ServiceAccount;
	const key = (cachedKey ??= await importPrivateKey(sa.private_key));

	const header = { alg: 'RS256', typ: 'JWT' };
	const claims = {
		iss: sa.client_email,
		scope: SCOPE,
		aud: TOKEN_ENDPOINT,
		iat: now,
		exp: now + 3600,
	};
	const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`;
	const sig = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		new TextEncoder().encode(unsigned),
	);
	const jwt = `${unsigned}.${b64url(new Uint8Array(sig))}`;

	const res = await fetch(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt,
		}),
	});
	if (!res.ok) {
		throw new SheetsError(
			`token exchange failed: ${res.status} ${await res.text()}`,
			res.status,
		);
	}
	const body = (await res.json()) as {
		access_token: string;
		expires_in: number;
	};
	cachedToken = {
		value: body.access_token,
		expiresAt: now + body.expires_in,
	};
	return body.access_token;
}

// PEM (PKCS$8) から CryptoKey を作成する
async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const b64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/, '')
		.replace(/-----END PRIVATE KEY-----/, '')
		.replace(/\s+/g, '');
	const bin = atob(b64);
	const der = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
	return crypto.subtle.importKey(
		'pkcs8',
		der,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
}

// Sheets操作

export class SheetsError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = 'SheetsError';
		this.status = status;
	}
}

async function api(
	env: SheetsEnv,
	path: string,
	init: RequestInit = {},
): Promise<unknown> {
	const token = await getAccessToken(env);
	const res = await fetch(`${SHEETS_API}${path}`, {
		...init,
		headers: {
			...(init.headers as Record<string, string> | undefined),
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
	});
	if (!res.ok) {
		throw new SheetsError(
			`sheets api ${res.status}: ${await res.text()}`,
			res.status,
		);
	}
	return res.json();
}

// スプレッドシートがサービスアカウントで操作可能か確認
export async function probeAccess(
	env: SheetsEnv,
	spreadsheetId: string,
): Promise<{ title: string; timeZone: string; sheetTitles: string[] }> {
	const r = (await api(
		env,
		`/${encodeURIComponent(spreadsheetId)}` +
			`?fieldss=properties.title,properties.timeZone,sheets.properties.title`,
	)) as {
		properties: { title: string; timeZone?: string };
		sheets: { properties: { title: string } }[];
	};
	return {
		title: r.properties.title,
		timeZone: r.properties.timeZone || 'Asia/Tokyo',
		sheetTitles: r.sheets.map((s) => s.properties.title),
	};
}

export function quoteSheet(title: string): string {
	return `'${title.replace(/'/g, "''")}'`;
}

export interface SheetSpec {
	title: string;
	header: string[];
	headerFormulas?: Record<number, string>;
	rows?: string[][];
}

// シートに必要なタブを作成する。
// すでにあるタブには何もしない。
export async function ensureSheets(
	env: SheetsEnv,
	spreadsheetId: string,
	specs: SheetSpec[],
): Promise<string[]> {
	const { sheetTitles } = await probeAccess(env, spreadsheetId);
	const missing = specs.filter((s) => !sheetTitles.includes(s.title));
	if (missing.length === 0) return [];
	// タブの作成をまとめて1回で行う
	await api(env, `/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
		method: 'POST',
		body: JSON.stringify({
			requests: missing.map((s) => ({
				addSheet: { properties: { title: s.title } },
			})),
		}),
	});

	// ヘッダ行の書き込みも1回にまとめて行う
	// appendで書き込むと、位置がずれる可能性があるため、updateで上書きする
	const data = missing.map((s) => {
		const row: string[] = [...s.header];
		for (const [i, f] of Object.entries(s.headerFormulas ?? [])) {
			row[Number(i)] = f;
		}
		return {
			range: `${quoteSheet(s.title)}!A1`,
			values: [row, ...(s.rows ?? [])],
		};
	});
	await api(env, `/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
		method: 'POST',
		body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
	});

	return missing.map((s) => s.title);
}

// 末尾に行を追加する
export async function appendRows(
	env: SheetsEnv,
	spreadsheetId: string,
	sheetTitle: string,
	columns: string,
	rows: (string | number)[][],
): Promise<void> {
	const range = encodeURIComponent(`${quoteSheet(sheetTitle)}!${columns}`);
	await api(
		env,
		`/${encodeURIComponent(spreadsheetId)}/values/${range}:append` +
			`?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
		{ method: 'POST', body: JSON.stringify({ values: rows }) },
	);
}

// 複数の範囲を1回のAPI呼び出しで済む
export async function batchReadRanges(
	env: SheetsEnv,
	spreadsheetId: string,
	ranges: string[],
): Promise<string[][][]> {
	if (ranges.length === 0) return [];
	const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
	const r = (await api(
		env,
		`/${encodeURIComponent(spreadsheetId)}/values:batchGet?${qs}`,
	)) as { valueRanges?: { values?: string[][] }[] };
	const got = r.valueRanges ?? [];
	return ranges.map((_, i) => got[i]?.values ?? []);
}

export async function updateRange(
	env: SheetsEnv,
	spreadsheetId: string,
	a1: string,
	rows: (string | number)[][],
): Promise<void> {
	await api(
		env,
		`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}` +
			`?valueInputOption=USER_ENTERED`,
		{ method: 'PUT', body: JSON.stringify({ values: rows }) },
	);
}

export async function readRange(
	env: SheetsEnv,
	spreadsheetId: string,
	a1: string,
): Promise<string[][]> {
	const r = (await api(
		env,
		`/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}`,
	)) as { values?: string[][] };
	return r.values ?? [];
}

// 日時をSheetsが理解できる形式に変換する
export function formatSheetDateTime(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	}).formatToParts(new Date(ms));
	const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
	// hourが24になることがあるので、0に戻す
	const hh = g('hour') === '24' ? '00' : g('hour');
	return `${g('year')}-${g('month')}-${g('day')} ${hh}:${g('minute')}:${g('second')}`;
}

// 配信URLとタイムスタンプからその瞬間に飛ぶURLを作成する
// YouTubeは &t=123 のように秒数を指定する
// Twitchは ?t=01h23m45s のように時間を指定する
// それ以外は素のURLを返す
export function timestampedUrl(url: string, sec: number | null): string {
	if (!url) return '';
	const t = sec == null ? 0 : Math.floor(sec);
	if (t <= 0) return url;

	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return url;

	const host = u.hostname.toLowerCase().replace(/^www\./, '');

	// YouTube
	if (
		host === 'youtube.com' ||
		host === 'm.youtube.com' ||
		host === 'music.youtube.com' ||
		host === 'youtu.be'
	) {
		u.searchParams.set('t', String(t));
		return u.toString();
	}

	// Twitch
	if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
		// アーカイブ以外はタイムスタンプが効かない
		if (!/^\/videos\/\d+/.test(u.pathname)) return url;
		const p = (n: number) => String(n).padStart(2, '0');
		const hms =
			`${p(Math.floor(t / 3600))}h` +
			`${p(Math.floor((t % 3600) / 60))}m` +
			`${p(t % 60)}s`;
		u.searchParams.set('t', hms);
		return u.toString();
	}

	// その他は素のURLを返す
	return url;
}

// スプレッドシートURLからIDを抽出する
export function extractSpreadsheetId(input: string): string | null {
	const s = input.trim();
	const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s);
	if (m) return m[1];
	return /^[a-zA-Z0-9-_]{20,}$/.test(s) ? s : null;
}

// helpers
function b64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(o: unknown): string {
	return b64url(new TextEncoder().encode(JSON.stringify(o)));
}
