import { z } from 'zod';

export const SongReqSchema = z.object({
	title: z.string().max(255).default(''),
	artist: z.string().max(255).default(''),
	readingTitle: z.string().max(255).default(''),
});

export type SongReq = z.infer<typeof SongReqSchema>;

export interface SongBackCache extends SongReq {
	id: string;
}

export interface SongRes extends SongReq {
	id: string;
	createdAt: string;
}
