import { z } from 'zod';

// スプレッドシートは2つのタブに分ける
export const REPERTOIRE_SHEET = 'Repertoire';
export const HISTORY_SHEET = 'History';

export const REPERTOIRE_HEADER = [
	'ID', // A song_id(マスターDBのID)
	'曲名', // B title
	'歌手名', // C artist
	'キー設定', // D key    "+2"など
	'音源URL', // E source_url
	'歌詞URL', // F lyric_url
	'習熟度', // G status
	'タグ', // H tags
	'メモ', // I notes
	'累計回数', // J sing_count     数式
	'最終歌唱日', // K last_sung_at   数式
] as const;

// A～Iまではアプリケーションが記入し、J/Kは数式に任せる
export const REPERTOIRE_WRITE_RANGE = 'A:I';
export const REPERTOIRE_WRITE_COLUMNS = 9;

export const HISTORY_HEADER = [
	'ID', //A song_id
	'歌唱日時', //B Sung_at
	'曲名', //C title
	'配信URL', //D stream_url
	'タイムスタンプ(秒)', //E timestamp_sec
] as const;

export const HISTORY_WRITE_RANGE = 'A:E';

// 公開設定
// 何を視聴者に見せるのかは配信者ごとに異なる
export const SETTINGS_SHEET = 'Settings';
export const SETTINGS_HEADER = ['項目', '公開する', '説明'] as const;

export interface PublicFieldDef {
	key: PublicFieldKey;
	label: string;
	default: boolean;
}

export type PublicFieldKey =
	| 'repertoire.songId'
	| 'repertoire.key'
	| 'repertoire.status'
	| 'repertoire.tags'
	| 'repertoire.notes'
	| 'repertoire.singCount'
	| 'repertoire.lastSungAt'
	| 'history.songId'
	| 'history.streamUrl'
	| 'history.timestampSec';

export const PUBLIC_FIELD_DEFS: readonly PublicFieldDef[] = [
	{
		key: 'repertoire.songId',
		label: '持ち歌: 曲ID (内部用の識別子)',
		default: false,
	},
	{
		key: 'repertoire.key',
		label: '持ち歌: キー設定 (+2 など)',
		default: true,
	},
	{ key: 'repertoire.status', label: '持ち歌: 習熟度', default: true },
	{ key: 'repertoire.tags', label: '持ち歌: タグ', default: true },
	{ key: 'repertoire.notes', label: '持ち歌: メモ', default: false },
	{ key: 'repertoire.singCount', label: '持ち歌: 累計回数', default: true },
	{
		key: 'repertoire.lastSungAt',
		label: '持ち歌: 最終歌唱日',
		default: true,
	},
	{ key: 'history.songId', label: '歌唱履歴: 曲ID', default: false },
	{ key: 'history.streamUrl', label: '歌唱履歴: 配信URL', default: true },
	{
		key: 'history.timestampSec',
		label: '歌唱履歴: タイムスタンプ(秒)',
		default: true,
	},
] as const;

// 切り替えられない項目
export const FIXED_FIELD_ROWS: readonly [string, string, string][] = [
	[
		'repertoire.title',
		'常に公開',
		'持ち歌: 曲名 — これが無いと公開ページが成立しない',
	],
	['repertoire.artist', '常に公開', '持ち歌: 歌手名 — 同上'],
	['history.sungAt', '常に公開', '歌唱履歴: 歌唱日時 — 同上'],
	['history.title', '常に公開', '歌唱履歴: 曲名 — 同上'],
	[
		'repertoire.sourceUrl',
		'常に非公開',
		'持ち歌: 音源URL — 権利的にも配らない',
	],
	['repertoire.lyricsUrl', '常に非公開', '持ち歌: 歌詞URL — 同上'],
];

export type PublicFieldFlags = Record<PublicFieldKey, boolean>;

export const DEFAULT_PUBLIC_FIELDS: PublicFieldFlags = Object.fromEntries(
	PUBLIC_FIELD_DEFS.map((d) => [d.key, d.default]),
) as PublicFieldFlags;

// PUT /me/public-fieldsの入力
export const publicFieldsInputSchema = z
	.object(
		Object.fromEntries(
			PUBLIC_FIELD_DEFS.map((d) => [d.key, z.boolean().optional()]),
		) as Record<PublicFieldKey, z.ZodOptional<z.ZodBoolean>>,
	)
	.strict();

export function repertoireFormulas(historySheet: string): {
	singCount: string;
	lastSungAt: string;
} {
	const h = `'${historySheet.replace(/'/g, "''")}'`;
	return {
		singCount:
			`=ARRAYFORMULA(IF(ROW($A:$A)=1,"累計回数",` +
			`IF($A:$A="","",COUNTIF(${h}!$A:$A,$A:$A))))`,
		lastSungAt:
			`=ARRAYFORMULA(IF(ROW($A:$A)=1,"最終歌唱日",` +
			`IF($A:$A="","",IFERROR(` +
			`TEXT(VLOOKUP($A:$A,SORT(${h}!$A:$B,2,FALSE),2,FALSE),"yyyy-mm-dd hh:mm")` +
			`,""))))`,
	};
}

const spreadsheetRef = z.string().trim().min(1).max(300);

// POST /streamers (登録) で使用
export const registerStreamerSchema = z.object({
	spreadsheet: spreadsheetRef, // スプレッドシートのURLまたはID
	displayName: z.string().trim().min(1).max(100).optional(),
	// タブ名(既定はRepertoireとHistory)
	repertoireSheet: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.default(REPERTOIRE_SHEET),
	historySheet: z.string().trim().min(1).max(100).default(HISTORY_SHEET),
});

export type RegisterStreamerInput = z.infer<typeof registerStreamerSchema>;

// 復旧 (トークン紛失)
export const recoverStartSchema = z.object({
	spreadsheet: spreadsheetRef,
});

export const recoverCompleteSchema = z.object({
	spreadsheet: spreadsheetRef,
	label: z.string().trim().min(1).max(50).optional(),
});

//トークンのスコープ
/**
 * full ... 通常のブラウザ用。設定変更・トークン管理まで可能
 * dock ... OBSのカスタムブラウザドック用。歌唱記録とオーバーレイ更新だけ
 */
export const tokenScopeSchema = z.enum(['full', 'dock']);
export type TokenScopeInput = z.infer<typeof tokenScopeSchema>;

// POST /pair/* OBSドックのペアリングで使用
export const HUMAN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/I/O/1を除外
export const PAIR_CODE_LENGTH = 8;
// 人が打ったコードを保存されている形に揃える
export function normalizeHumanCode(input: string): string {
	return input.replace(/[\s\u3000-]/g, '').toUpperCase();
}

const pairCode = z
	.string()
	.trim()
	.min(1)
	.max(32)
	.transform(normalizeHumanCode)
	.refine(
		(v) =>
			v.length === PAIR_CODE_LENGTH &&
			[...v].every((ch) => HUMAN_CODE_ALPHABET.includes(ch)),
		{ message: '接続コードの形式が不正です。' },
	);

const pairHandle = z
	.string()
	.trim()
	.min(20)
	.max(100)
	.regex(/^[A-Za-z0-9_-]+$/, 'handleの形式が不正です。');

// ログイン済みのブラウザがCodeを打つ
export const pairClaimSchema = z.object({
	code: pairCode,
});

// ドックがhandleと配信者が発行したCodeを打つ
export const pairConfirmSchema = z.object({
	code: pairCode,
	handle: pairHandle,
	pin: z
		.string()
		.trim()
		.regex(/^\d{3}$/, '確認番号は3桁の数字です。'),
});

// ドックが誰かが入力したかを確認する
export const pairStatusSchema = z.object({
	code: pairCode,
	handle: pairHandle,
});

export type PairClaimInput = z.infer<typeof pairClaimSchema>;
export type PairConfirmInput = z.infer<typeof pairConfirmSchema>;
export type PairStatusInput = z.infer<typeof pairStatusSchema>;

// POST /auth/session (ログインのようなもの) で使用

export const loginSchema = z.object({
	token: z.string().trim().min(1).max(200),
});

// PATCH /me (シート名・表示名の変更) で使用
export const updateStreamerSchema = z.object({
	repertoireSheet: z.string().trim().min(1).max(100).optional(),
	historySheet: z.string().trim().min(1).max(100).optional(),
	isPublic: z.boolean().optional(), // 既定はfalse
	displayName: z.string().trim().min(1).max(100).nullable().optional(),
});

// POST /me/token (追加トークン) で使用
export const issueTokenSchema = z.object({
	label: z.string().trim().min(1).max(50).optional(),
	scope: tokenScopeSchema.default('dock'),
});

// POST /me/performance (歌唱記録) で使用
export const performanceInputSchema = z.object({
	songId: z.string().trim().min(1).max(64), // マスターDBの曲ID
	sungAt: z.iso.datetime().optional(), // 歌った時刻(ISO8601)
	streamUrl: z.url().trim().max(500).optional(), // 視聴者に見せる配信URL
	timestampSec: z
		.number()
		.int()
		.min(0)
		.max(86400 * 7)
		.optional(), // 配信開始からの秒数
	clientId: z.string().trim().min(8).max(64).optional(),
});

export const createPerformancesSchema = z
	.union([
		performanceInputSchema,
		z.array(performanceInputSchema).min(1).max(100),
	])
	.transform((v) => (Array.isArray(v) ? v : [v]));

export type PerformanceInput = z.infer<typeof performanceInputSchema>;

// Repertoire (持ち歌)で使用
export const repertoireItemSchema = z.object({
	songId: z.string().trim().min(1).max(64),
	title: z.string().trim().max(200).default(''),
	artist: z.string().trim().max(200).default(''),
	key: z.string().trim().max(20).default(''), // "+2". "-1"など
	sourceUrl: z.string().trim().max(500).default(''),
	lyricsUrl: z.string().trim().max(500).default(''),
	status: z.string().trim().max(50).default(''), // 習熟度。◎◯△でも、練習中でもよい
	tags: z.string().trim().max(200).default(''), // カンマ区切り
	notes: z.string().trim().max(500).default(''),
});

export type RepertoireItem = z.infer<typeof repertoireItemSchema>;

export const addRepertoireSchema = z
	.union([
		repertoireItemSchema,
		z.array(repertoireItemSchema).min(1).max(200),
	])
	.transform((v) => (Array.isArray(v) ? v : [v]));

export const repertoireRowSchema = repertoireItemSchema.extend({
	singCount: z.number().nullable(),
	lastSungAt: z.string().nullable(),
	row: z.number(),
});

export type RepertoireRow = z.infer<typeof repertoireRowSchema>;

// 視聴者に見せる持ち歌
// 通す列を明示的に並べる
// sourceUrl/ lyricsUrl, notes, rowは除外する
export const publicRepertoireItemSchema = z.object({
	// 常に入る
	title: z.string(),
	artist: z.string(),
	// Settingsタブの設定次第でキーごと消える
	songId: z.string().optional(),
	key: z.string().optional(),
	status: z.string().optional(),
	tags: z.string().optional(),
	notes: z.string().optional(),
	singCount: z.number().nullable().optional(),
	lastSungAt: z.string().nullable().optional(),
});

// 視聴者に見せる歌唱履歴
export const publicHistoryItemSchema = z.object({
	// 常に入る
	sungAt: z.string(),
	title: z.string(),
	// 設定次第
	songId: z.string().optional(),
	streamUrl: z.string().optional(),
	timestampSec: z.number().nullable().optional(),
	// streamUrlが公開の場合のみ入る
	watchUrl: z.string().optional(),
});

export type PublicHistoryItem = z.infer<typeof publicHistoryItemSchema>;

export type PublicRepertoireItem = z.infer<typeof publicRepertoireItemSchema>;

// 視聴者に見せる廃止員者のプロフィール
export const publicStreamerSchema = z.object({
	id: z.string(),
	displayName: z.string().nullable(),
});

export type PublicStreamer = z.infer<typeof publicStreamerSchema>;

export const publicListSchema = z.object({
	limit: z.preprocess(
		(v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
		z.coerce.number().int().min(1).max(500).default(100),
	),
});

export const listPerformancesSchema = z.object({
	limit: z.preprocess(
		(v) => (typeof v === 'string' && v.trim() == '' ? undefined : v),
		z.coerce.number().int().min(1).max(200).default(50),
	),
});

// レスポンス型 (フロントと共有)
export const streamerSchema = z.object({
	id: z.string(),
	spreadsheetId: z.string(),
	spreadsheetUrl: z.string(),
	spreadsheetTitle: z.string().nullable(),
	repertoireSheet: z.string(),
	historySheet: z.string(),
	timezone: z.string(),
	displayName: z.string().nullable(),
	isPublic: z.boolean(),
	createdAt: z.string(),
});

export type Streamer = z.infer<typeof streamerSchema>;

// GET /meとPOST /auth/sessionのレスポンスで使用
export const sessionResponseSchema = z.object({
	streamer: streamerSchema,
	scope: tokenScopeSchema,
	tokenLabel: z.string().nullable(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const registerResponseSchema = z.object({
	streamer: streamerSchema,
	token: z.string(),
	warning: z.string(),
});

export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const performanceSchema = z.object({
	songId: z.string(),
	sungAt: z.string(),
	title: z.string(),
	streamUrl: z.string(),
	timestampSec: z.number().nullable(),
	watchUrl: z.string(),
	row: z.number(),
});

export type Performance = z.infer<typeof performanceSchema>;

export type HistoryRow = Performance;
