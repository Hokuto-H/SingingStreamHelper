// シートの行とJSONの変換を行う関数群

import { timestampedUrl } from './sheets';
import {
	DEFAULT_PUBLIC_FIELDS,
	FIXED_FIELD_ROWS,
	PUBLIC_FIELD_DEFS,
	type HistoryRow,
	type PublicFieldFlags,
	type PublicFieldKey,
	type PublicHistoryItem,
	type PublicRepertoireItem,
	type RepertoireRow,
} from './streamer-schema';

// 公開設定 (Settingsタブ)
function truthy(v: string | undefined): boolean | null {
	const t = (v ?? '').trim().toLowerCase();
	if (t === '') return null;
	if (
		[
			'true',
			'1',
			'yes',
			'y',
			'on',
			'はい',
			'○',
			'◯',
			'✓',
			'公開',
			'する',
		].includes(t)
	) {
		return true;
	}
	if (
		[
			'false',
			'0',
			'no',
			'n',
			'off',
			'いいえ',
			'×',
			'✗',
			'非公開',
			'しない',
		].includes(t)
	) {
		return false;
	}
	return null;
}

// Settings!A2:Bのデータから公開フラグを作る
export function parseVisibility(values: string[][]): PublicFieldFlags {
	const known = new Set<string>(PUBLIC_FIELD_DEFS.map((d) => d.key));
	const flags: PublicFieldFlags = { ...DEFAULT_PUBLIC_FIELDS };
	for (const r of values) {
		const key = (r[0] ?? '').trim();
		if (!known.has(key)) continue;
		const v = truthy(r[1]);
		if (v !== null) flags[key as PublicFieldKey] = v;
	}
	return flags;
}

//Settingsタブに最初に書き込む中身
export function settingsRows(
	flags: PublicFieldFlags = DEFAULT_PUBLIC_FIELDS,
): string[][] {
	return [
		...PUBLIC_FIELD_DEFS.map((d) => [
			d.key,
			flags[d.key] ? 'TRUE' : 'FALSE',
			d.label,
		]),
		...FIXED_FIELD_ROWS.map((r) => [...r]),
	];
}

// Repertoire
export function parseRepertoireRows(values: string[][]): RepertoireRow[] {
	const items: RepertoireRow[] = [];
	values.forEach((r, i) => {
		const songId = (r[0] ?? '').trim();
		if (!songId) return;
		const count = Number(r[9]);
		items.push({
			songId,
			title: r[1] ?? '',
			artist: r[2] ?? '',
			key: r[3] ?? '',
			sourceUrl: r[4] ?? '',
			lyricsUrl: r[5] ?? '',
			status: r[6] ?? '',
			tags: r[7] ?? '',
			notes: r[8] ?? '',
			singCount: Number.isFinite(count) ? count : null,
			lastSungAt: (r[10] ?? '') === '' ? null : String(r[10]),
			row: i + 2, // A2から始まるので+2する
		});
	});
	return items;
}

// 視聴者に見せてよい列だけを返す
export function toPublicRepertoire(
	items: RepertoireRow[],
	flags: PublicFieldFlags = DEFAULT_PUBLIC_FIELDS,
): PublicRepertoireItem[] {
	return items.map((i) => {
		const out: PublicRepertoireItem = { title: i.title, artist: i.artist };
		if (flags['repertoire.songId']) out.songId = i.songId;
		if (flags['repertoire.key']) out.key = i.key;
		if (flags['repertoire.status']) out.status = i.status;
		if (flags['repertoire.tags']) out.tags = i.tags;
		if (flags['repertoire.notes']) out.notes = i.notes;
		if (flags['repertoire.singCount']) out.singCount = i.singCount;
		if (flags['repertoire.lastSungAt']) out.lastSungAt = i.lastSungAt;
		return out;
	});
}

// History
// 配信者向け
export function parseHistoryRows(
	values: string[][],
	limit: number,
): HistoryRow[] {
	const rows = values
		.map((r, i) => ({ r, row: i + 2 }))
		.filter((x) => (x.r[0] ?? '').trim() !== '');

	return rows
		.slice(Math.max(0, rows.length - limit))
		.reverse()
		.map(({ r, row }) => {
			const sec = Number(r[4]);
			const timestampSec =
				(r[4] ?? '') === '' || !Number.isFinite(sec) ? null : sec;
			const streamUrl = r[3] ?? '';
			return {
				songId: String(r[0]).trim(),
				sungAt: r[1] ?? '',
				title: r[2] ?? '',
				streamUrl,
				timestampSec,
				watchUrl: timestampedUrl(streamUrl, timestampSec),
				row,
			};
		});
}

// 歌唱履歴の公開版
export function toPublicHistory(
	items: HistoryRow[],
	flags: PublicFieldFlags = DEFAULT_PUBLIC_FIELDS,
): PublicHistoryItem[] {
	const showUrl = flags['history.streamUrl'];
	const showSec = flags['history.timestampSec'];
	return items.map((i) => {
		const out: PublicHistoryItem = { sungAt: i.sungAt, title: i.title };
		if (flags['history.songId']) out.songId = i.songId;
		if (showUrl) out.timestampSec = i.timestampSec;
		if (showUrl) {
			out.streamUrl = i.streamUrl;
			out.watchUrl = showSec ? i.watchUrl : i.streamUrl;
		}
		return out;
	});
}
