// 配信者のアクセストークン
// 接頭辞をつける
const TOKEN_PREFIX = 'sst_';

// 新しいトークンを発行する
// 戻り値の平文は1回のみで、保存はハッシュ化したもの
export async function issueToken(): Promise<{ token: string; hash: string }> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const token = TOKEN_PREFIX + base64url(bytes);
	return { token, hash: await hashToken(token) };
}

// DB検索前に、トークンの形式を確認する
export function looksLikeToken(v: string): boolean {
	return v.startsWith(TOKEN_PREFIX) && v.length >= TOKEN_PREFIX.length + 40;
}

// SHA-256でハッシュ化する
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token),
	);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export function bearerFrom(header: string | undefined): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? m[1].trim() : null;
}

function base64url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
