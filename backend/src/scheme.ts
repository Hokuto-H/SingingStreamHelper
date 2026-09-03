import { z } from 'zod';
import { MAX_LIMIT, MAX_WINDOW, isPageOutOfWindow } from './search';

z.config({
	customError: (issue) => {
		switch (issue.code) {
			case 'invalid_type':
				return issue.input === undefined
					? '必須です'
					: `${issue.expected} を指定してください`;

			case 'too_small':
				return issue.origin === 'string' || issue.origin === 'char'
					? `${issue.minimum} 文字以上で指定してください`
					: issue.origin === 'array'
						? `${issue.minimum} 件以上で指定してください`
						: `${issue.minimum} 以上で指定してください`;

			case 'too_big':
				return issue.origin === 'string' || issue.origin === 'char'
					? `${issue.maximum} 文字以内で指定してください`
					: issue.origin === 'array'
						? `${issue.maximum} 件以内で指定してください`
						: `${issue.maximum} 以下で指定してください`;

			case 'invalid_value':
				return '指定できない値です';

			default:
				return undefined; // デフォルトメッセージを使用する場合は undefined を返す
		}
	},
});

// 共通

const emptyToUndefined = (v: unknown) =>
	typeof v === 'string' && v.trim() === '' ? undefined : v;

const textParam = (max: number) =>
	z.preprocess(
		emptyToUndefined,
		z.string().trim().min(1).max(max).optional(),
	);

const intParam = (dflt: number, min: number, max: number) =>
	z.preprocess(
		emptyToUndefined,
		z.coerce.number().int().min(min).max(max).default(dflt),
	);

// readingTitleに許す文字
// ひらがな、長音符、中黒、空白のみ
const HIRAGANA_ONLY = /^[ぁ-ゖーー・\s]+$/u;
const HAS_HIRAGANA = /[ぁ-ゖ]/u;

// GET /songs

export const searchQuerySchema = z
	.object({
		title: textParam(200),
		artist: textParam(200),
		sort: z.preprocess(emptyToUndefined, z.literal('index').optional()),
		limit: intParam(20, 1, MAX_LIMIT),
		page: intParam(1, 1, MAX_LIMIT),
	})
	.refine((v) => v.title !== undefined || v.artist !== undefined, {
		message: '曲名またはアーティスト名を1文字以上入力してください',
		path: ['title'],
	})
	.refine((v) => !isPageOutOfWindow(v.limit, v.page), {
		message: `検索結果は先頭 ${MAX_WINDOW} 件までです。曲名かアーティスト名をもう少し詳しく指定してください。`,
		path: ['page'],
	});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

// GET /songs/suggest

export const suggestQuerySchema = z
	.object({
		title: textParam(200),
		artist: textParam(200),
		limit: intParam(20, 1, MAX_LIMIT),
	})
	.refine((v) => v.title !== undefined || v.artist !== undefined, {
		message: '曲名またはアーティスト名を1文字以上入力してください',
		path: ['title'],
	});

export type SuggestQuery = z.infer<typeof suggestQuerySchema>;

// POST /songs

export const songInputSchema = z.object({
	title: z.string().trim().min(1).max(200),
	readingTitle: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.regex(
			HIRAGANA_ONLY,
			'readingTitle はひらがな、長音符、中黒、空白のみで指定してください',
		)
		.regex(HAS_HIRAGANA, 'readingTitle にひらがなが含まれていません'),
	artist: z.string().trim().min(1).max(200),
});

export type SongInput = z.infer<typeof songInputSchema>;

export const createSongsSchema = z
	.union([songInputSchema, z.array(songInputSchema).min(1).max(500)])
	.transform((v) => (Array.isArray(v) ? v : [v]));

export const createQuerySchema = z.object({
	// 重複が見つかった場合の挙動
	// error ... 1件でも重複していたら409で何も登録しない(既定)
	// skip  ... 重複だけ飛ばして残りを登録する
	onDuplicate: z.preprocess(
		emptyToUndefined,
		z.enum(['error', 'skip']).default('error'),
	),
});

export type CreateQuery = z.infer<typeof createQuerySchema>;

// レスポンス

export const songSchema = z.object({
	id: z.string(),
	title: z.string(),
	readingTitle: z.string(),
	artist: z.string(),
	createdAt: z.string(),
});

export type Song = z.infer<typeof songSchema>;

export const searchResponseSchema = z.object({
	items: z.array(songSchema),
	page: z.number(),
	limit: z.number(),
	hasMore: z.boolean(),
	refine: z.boolean(),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const suggestResponseSchema = z.object({
	items: z.array(songSchema),
	complete: z.boolean(),
	source: z.enum(['hot', 'none']),
});

export type SuggestResponse = z.infer<typeof suggestResponseSchema>;

export const createResponseSchema = z.object({
	created: z.array(songSchema),
	skipped: z.array(
		z.object({
			title: z.string(),
			artist: z.string(),
			existingId: z.string().nullable(),
		}),
	),
});

export type CreateResponse = z.infer<typeof createResponseSchema>;
