/**
 * 検索キーの正規化
 * 1. NFKC ... 半角カナ→全角カナ、全角英数→半角英数、濁点は合成系に統一
 * 2. toLowerCase ... 大文字→小文字
 * 3. カタカナ化 ... ひらがな/カタカナの同一視
 * 4. 記号・空白・長音符の除去 ... "レッツ・ゴー!" → "レッツゴー"
 */

// 小書き文字を大書き文字に変換するマップ
const STRIP_RE = /[\s\p{P}\p{S}ー]/gu;

/**
 * カタカナ変換関数
 * @param str 入力文字列
 * @returns カタカナに変換された文字列
 */
function toKatakana(str: string): string {
	return str.replace(/[ぁ-ゖ]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) + 0x60),
	);
}

/**
 * 正規化された文字列を返す関数
 * @param input 入力文字列
 * @returns 正規化された文字列
 */
export function normalizeKey(input: string): string {
	return toKatakana(input.normalize('NFKC').toLowerCase()).replace(
		STRIP_RE,
		'',
	);
}

/**
 * カタカナのみで構成されているかを判定する
 * @param key 対象の文字列
 * @returns カタカナのみかどうか
 */
export function isKanaOnly(key: string): boolean {
	return key.length > 0 && /^[ァ-ヺ]+$/.test(key);
}

/**
 * この関数では、LIKE検索の代わりに、インデックスを使った範囲検索を行うための上限と下限を返す
 *
 * 例えば、「ヨル」で始まる曲を検索する場合、LIKE 'ヨル%'で検索することになる。
 * LIKEは原則として全票走査になるため、インデックスが効かず、読み取り回数が増える。
 *
 * ここで、B-treeインデックスは辞書順に並んでいるため、"ヨル"で始まる曲は連続した範囲に存在する
 * 上限と下限さえ分かれば、
 *
 *  WHERE title_key >= 'ヨル' AND title_key < 'ヨレ'
 *
 * のように書け、インデックスを2分探索するだけで済む。
 *
 * 上限は、prefixの最後の文字を1つ進めた文字に置き換えた文字列になる。
 */

export function prefixRange(prefix: string): [string, string] {
	const cps = [...prefix];
	const last = cps.pop();
	if (last === undefined) throw new Error('empty prefix');

	let next = last.codePointAt(0)! + 1;
	if (next >= 0xd800 && next <= 0xdfff) next = 0xe000; // サロゲートペアの範囲を避ける
	if (next > 0x10ffff) {
		return [prefix, prefix + '\u{10FFFF}\u{10FFFF}'];
	}
	return [prefix, cps.join('') + String.fromCodePoint(next)];
}
