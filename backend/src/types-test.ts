import { z } from 'zod';

export const SongReqSchema = z.object({
	title: z.string().max(255).default(''),
	artist: z.string().max(255).default(''),
	readingTitle: z.string().max(255).default(''),
});

export const SongSearchQuerySchema = z.object({
	title: z.string().max(255).default(''),
	artist: z.string().max(255).default(''),
	sort: z
		.enum([
			'latest',
			'oldest',
			'title_asc',
			'title_desc',
			'artist_asc',
			'artist_desc',
			'popular',
		])
		.default('latest'),
	limit: z.coerce.number().min(10).max(100).default(40),
	page: z.coerce.number().min(1).default(1),
});

export type SongReq = z.infer<typeof SongReqSchema>;

export interface SongBackCache extends SongReq {
	id: string;
}

export interface SongRes extends SongReq {
	id: string;
	createdAt: string;
}
