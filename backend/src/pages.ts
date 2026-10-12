// OBSに貼る2枚の画面

import { Hono } from 'hono';

export const pages = new Hono();

const HTML_HEADERS = {
	'content-type': 'text/html; charset=UTF-8',
	'cache-control': 'no-store',
} as const;

// オーバーレイ (ブラウザソース)

const OVERLAY_BASE_CSS = /* css */ `
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    .np { font-family: "Noto Sans JP", "Yu Gothic UI", sans-serif; }
    /* 中身が無い要素は詰めない (:empty は空白 1 個で壊れるので data 属性で見る) */
    .np[data-has-artist="false"] .np-artist,
    .np[data-has-key="false"] .np-key,
    .np[data-has-next="false"] .np-next { display: none; }

    /* ─────────────────────────────────────────────────────
        長い曲名を横スクロールさせるための道具。

        data-title-overflow / data-line-overflow   "true" / "false"
        --np-title-overflow-px / --np-line-overflow-px   はみ出した量
        --np-title-duration / --np-line-duration         速度から計算した所要時間
     ───────────────────────────────────────────────────── */
    @keyframes np-marquee {
        from { transform: translateX(0); }
        to   { transform: translateX(calc(-1 * var(--np-marquee-distance, 0px))); }
    }

    /* ② 端まで行ったら先頭に戻って、また同じ向きへ流れる。
        ★ 両端で止まる「間」を keyframes 側に持たせてある (0〜14% と 86〜100%)。
        この割合は measure() の MOVE_RATIO と対になっている。片方だけ変えないこと。 */
    @keyframes np-marquee-loop {
        0%,  14%  { transform: translateX(0); }
        86%, 100% { transform: translateX(calc(-1 * var(--np-marquee-distance, 0px))); }
    }

    /* ③ 右の外から入ってきて、左の外へ抜ける (電光掲示板)。
        戻る瞬間が無いので継ぎ目が出ない。代わりに何も映らない間ができる。 */
    @keyframes np-marquee-through {
        from { transform: translateX(var(--np-marquee-start, 0px)); }
        to   { transform: translateX(calc(-1 * var(--np-marquee-distance, 0px))); }
    }

    /* ④ (複製して継ぎ目なく流す) で置かれた ::after を、**幅を測るあいだだけ**消す。
        ★ 消さないと「複製込みの幅」を自然幅として返してしまう。
        自然幅が増える → 複製の距離が伸びる → また増える、と発散して壊れる。 */
    .np-measuring .np-now::after,
    .np-measuring .np-title::after { content: none !important; }
`;

/**
 * 既定の見た目。**bare=1 で丸ごと落ちる。**
 *
 * ★ セレクタは単一クラスに寄せてある。配信者の CSS が
 *   同じ特異度なら後から当たったほうが勝つ。
 *   もし効かないときは `.np .np-title` のように 1 段上げてもらう。
 */
const OVERLAY_THEMES: Record<string, string> = {
	default: /* css */ `
        .np { padding: 16px 22px; display: inline-block; color: #fff;
            text-shadow: 0 2px 6px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9); }
        .np-now { opacity: 0; transform: translateY(8px);
                transition: opacity .35s ease, transform .35s ease; }
        .np-title { font-size: 34px; font-weight: 700; line-height: 1.25; }
        .np-meta { font-size: 20px; font-weight: 500; opacity: .85; margin-top: 4px; }
        .np-key { font-size: 17px; opacity: .7; margin-left: .6em; }
        /* ★「次の曲」は既定で隠す。出したい人は display を戻すだけ */
        .np-next { display: none; font-size: 16px; opacity: .7; margin-top: 10px; }
        .np-next-label { opacity: .6; margin-right: .5em; }
        .np-next-artist { margin-left: .5em; opacity: .8; }
`,
	card: /* css */ `
        .np { padding: 14px 20px; display: inline-block; color: #fff;
            background: rgba(18,20,26,.72); border-radius: 12px;
            border: 1px solid rgba(255,255,255,.12); }
        .np-now { opacity: 0; transform: translateY(6px);
                transition: opacity .3s ease, transform .3s ease; }
        .np-title { font-size: 30px; font-weight: 700; line-height: 1.2; }
        .np-meta { font-size: 18px; opacity: .8; margin-top: 2px; }
        .np-key { font-size: 15px; opacity: .65; margin-left: .6em; }
        .np-next { display: none; font-size: 15px; opacity: .6; margin-top: 8px;
                border-top: 1px solid rgba(255,255,255,.12); padding-top: 8px; }
        .np-next-label { opacity: .6; margin-right: .5em; }
        .np-next-artist { margin-left: .5em; opacity: .8; }
`,
	minimal: /* css */ `
        .np { padding: 8px 12px; display: inline-block; color: #fff;
            text-shadow: 0 1px 4px rgba(0,0,0,.9); }
        .np-now { opacity: 0; transition: opacity .25s ease; }
        .np-title { font-size: 22px; font-weight: 600; }
        .np-title::before { content: "♪ "; opacity: .7; }
        .np-meta { display: inline; font-size: 18px; opacity: .75; margin-left: .5em; }
        .np-key { opacity: .6; margin-left: .4em; }
        .np-next { display: none; font-size: 16px; opacity: .6; margin-top: 6px; }
        .np-next-label { opacity: .6; margin-right: .5em; }
        .np-next-artist { margin-left: .5em; opacity: .8; }
        `,
	/** 既定 CSS を一切当てない。全部 OBS のカスタムCSSで書く人向け */
	bare: '',
};

/**
 * 表示中は .np-now を出す。
 * ★ ここだけ特異度が (0,2,0) になる。状態に応じた見た目は CSS 単独では
 *   書けないので避けられない。配信者が上書きするときは同じ形で書いてもらう。
 */
const OVERLAY_STATE_CSS = /* css */ `
    .np[data-state="playing"] .np-now { opacity: 1; transform: none; }
`;

const OVERLAY_DEBUG_CSS = /* css */ `
    .np-debug { display: none; }
    body.debug { background: #14161b; }
    body.debug .np-debug {
        display: block; position: fixed; left: 0; right: 0; bottom: 0;
        font-family: ui-monospace, "Yu Gothic UI", monospace;
        font-size: 13px; line-height: 1.7; color: #cbd2de; background: #1f222a;
        border-top: 1px solid #2e323c; padding: 10px 14px;
    }
    body.debug .np { outline: 1px dashed #3a404c; }
    .np-st { font-weight: 700; }
    .np-st-up { color: #4ade80; } .np-st-down { color: #fb7185; }
`;

function overlayHtml(themeCss: string): string {
	return /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Now Playing</title>
<style>${OVERLAY_BASE_CSS}${themeCss}${OVERLAY_STATE_CSS}${OVERLAY_DEBUG_CSS}</style>
</head>
<body>

<!-- ★ この構造とクラス名は「契約」。配信者がここに CSS を書く。
    追加はしてよいが、改名と削除はしないこと。 -->
<div class="np" data-state="idle" data-connection="down"
    data-has-artist="false" data-has-key="false" data-has-next="false"
    ><div class="np-now"
        ><div class="np-title"></div
        ><div class="np-meta"
            ><span class="np-artist"></span
            ><span class="np-key"></span
        ></div
    ></div
    ><div class="np-next"
        ><span class="np-next-label">NEXT</span
        ><span class="np-next-title"></span
        ><span class="np-next-artist"></span
    ></div
></div>

<div class="np-debug">
    <div>接続: <span class="np-st np-st-down">未接続</span></div>
    <div>いまの曲: <span class="np-d-song">—</span></div>
    <div>次の曲: <span class="np-d-next">—</span></div>
    <div>最終受信: <span class="np-d-at">—</span></div>
    <div style="opacity:.6;margin-top:6px">
        これは ?debug=1 を付けたときだけ出ます。OBS には付けずに貼ってください。
    </div>
</div>

<script>
(() => {
    const q = new URLSearchParams(location.search);
    const key = q.get("key") || "";
    const debug = q.get("debug") === "1";
    const demo = q.get("demo") === "1";
    if (debug) document.body.classList.add("debug");

    const $ = (s) => document.querySelector(s);
    const root = $(".np");
    const elNow = $(".np-now");
    const elTitle = $(".np-title");
    const elArtist = $(".np-artist");
    const elKey = $(".np-key");
    const elNextTitle = $(".np-next-title");
    const elNextArtist = $(".np-next-artist");
    const st = $(".np-st"), dSong = $(".np-d-song"), dNext = $(".np-d-next"), dAt = $(".np-d-at");

    let ws = null, retry = 0, seq = -1;

    function note(up, got) {
        root.dataset.connection = up ? "up" : "down";
        if (!debug) return;
        st.textContent = up ? "接続中" : "切断";
        st.className = "np-st " + (up ? "np-st-up" : "np-st-down");
        if (got) dAt.textContent = new Date().toLocaleTimeString();
    }

    function render(song, next) {
        // ★ 古い通知を捨てる。再接続直後に初回状態と配信が前後することがある
        if (song && song.seq != null && song.seq < seq) return;
        if (song && song.seq != null) seq = song.seq;

        root.dataset.state = song ? "playing" : "idle";
        elTitle.textContent = song ? song.title : "";
        elArtist.textContent = song && song.artist ? song.artist : "";
        elKey.textContent = song && song.key ? song.key : "";
        // ★ 空の要素を CSS で畳めるようにする (:empty は空白で壊れるので使わない)
        root.dataset.hasArtist = String(Boolean(song && song.artist));
        root.dataset.hasKey = String(Boolean(song && song.key));

        elNextTitle.textContent = next ? next.title : "";
        elNextArtist.textContent = next && next.artist ? next.artist : "";
        root.dataset.hasNext = String(Boolean(next));

        // ★ 複製して流す書き方 (④) のための材料。
        //   CSS の content: attr(...) は**その要素自身の属性しか読めない**ので、
        //   複製を置く要素 (.np-title / .np-now) の側に持たせる。
        elTitle.dataset.text = song ? song.title : "";
        elNow.dataset.title = song ? song.title : "";
        elNow.dataset.artist = song && song.artist ? song.artist : "";

        // ★ 文字を入れた後に測る。入れる前に測ると前の曲の幅になる
        measure();

        if (debug) {
            dSong.textContent = song
                ? song.title + (song.artist ? " / " + song.artist : "")
                : "（待機中 — 曲が設定されていません）";
            dNext.textContent = next ? next.title : "—";
        }
    }

    // ─────────────────────────────────────────────────────
    // はみ出し量を測って CSS に渡す
    //
    // ★ CSS には「中身が枠より広いか」を問うセレクタが無い。
    //   ここを測らないと、配信者は「短い曲名まで動く」か
    //   「長い曲名が切れる」かのどちらかを選ぶことになる。
    //
    // ★ 所要時間は**距離 ÷ 速度**で出す。固定時間にすると、
    //   長い曲名ほど速く流れて読めなくなる。
    // ─────────────────────────────────────────────────────
    const DEFAULT_SPEED = 60;   // px/秒

    /**
     * 中身が実際に置ける幅 (コンテンツボックス)。
     *
     * ★ clientWidth をそのまま使ってはいけない。**padding を含む**ので、
     *   既定テーマの padding: 16px 22px のぶん (左右で 44px) だけ
     *   はみ出し量を少なく見積もる。
     *   結果、どこまで流しても曲名の末尾 2 文字ほどが枠の外に残り、
     *   「YOASOBI の BI が読めない」という形で出る。
     */
    function inner(el) {
        const cs = getComputedStyle(el);
        return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    }
    /**
     * 折り返さずに置いたときの幅。
     *
     * ★ scrollWidth では測れない。
     *   スクロール用の CSS は data-title-overflow="true" が付いて初めて当たるが、
     *   その CSS (white-space: nowrap) が無いと scrollWidth は折り返し後の幅になり、
     *   はみ出しが 0 と出る。→ 永久に true にならない。鶏と卵になる。
     *
     *   そこで**一時的に nowrap を当てて測り、すぐ戻す**。
     *   同じ同期ブロック内なので描画は挟まらず、ちらつかない。
     */
    function natural(el) {
        const prev = el.getAttribute("style");
        el.style.whiteSpace = "nowrap";
        el.style.display = "inline-block";
        el.style.width = "auto";
        el.style.maxWidth = "none";
        const w = el.getBoundingClientRect().width;
        if (prev === null) el.removeAttribute("style"); else el.setAttribute("style", prev);
        return w;
    }

    function measure() {
        const cs = getComputedStyle(root);
        const speed = parseFloat(cs.getPropertyValue("--np-marquee-speed")) || DEFAULT_SPEED;
        const gap = parseFloat(cs.getPropertyValue("--np-marquee-gap")) || 0;

        // ★ 枠の幅を先に取る。natural() は要素の style を一時的に触るので、
        //   後から測ると枠の幅まで変わってしまう。
        const nowBox = inner(elNow);
        const rootBox = inner(root);
        if (rootBox <= 0) return;   // 非表示のときは測らない

        root.classList.add("np-measuring");
        const titleNat = natural(elTitle);
        const lineNat = natural(elNow);
        root.classList.remove("np-measuring");

        const titleOver = Math.max(0, Math.round(titleNat - nowBox));
        const lineOver = Math.max(0, Math.round(lineNat - rootBox));

        root.dataset.titleOverflow = String(titleOver > 0);
        root.dataset.lineOverflow = String(lineOver > 0);

        const MOVE_RATIO = 0.72;
        const set = (k, v) => root.style.setProperty(k, v);

        set("--np-title-window-px", Math.round(nowBox) + "px");
        set("--np-line-window-px", Math.round(rootBox) + "px");
        set("--np-title-natural-px", Math.round(titleNat) + "px");
        set("--np-line-natural-px", Math.round(lineNat) + "px");
        set("--np-title-overflow-px", titleOver + "px");
        set("--np-line-overflow-px", lineOver + "px");
        // ① 往復。端で少し止まる余裕を足しておく (往復させたときに読みやすい)
        set("--np-title-duration", (titleOver / speed + 1.5).toFixed(2) + "s");
        set("--np-line-duration", (lineOver / speed + 1.5).toFixed(2) + "s");
        // ② 戻ってもう一度。止まる間が keyframes 側にあるぶん、全体を伸ばす
        set("--np-title-loop-duration", (titleOver / speed / MOVE_RATIO + 0.3).toFixed(2) + "s");
        set("--np-line-loop-duration", (lineOver / speed / MOVE_RATIO + 0.3).toFixed(2) + "s");
        // ③ 通り抜け。枠の外から外までなので、枠の幅ぶん長い
        set("--np-title-through-duration", ((nowBox + titleNat) / speed).toFixed(2) + "s");
        set("--np-line-through-duration", ((rootBox + lineNat) / speed).toFixed(2) + "s");
        // ④ 複製。1 周 = 自分の幅 + 継ぎ目の間隔
        set("--np-title-seamless-duration", ((titleNat + gap) / speed).toFixed(2) + "s");
        set("--np-line-seamless-duration", ((lineNat + gap) / speed).toFixed(2) + "s");
    }

    // 枠の幅は配信者の CSS が決めるので、変わったら測り直す
    if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(measure);
        ro.observe(root); ro.observe(elNow);
    }
    // Web フォントが後から効くと幅が変わる
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);

    function connect() {
        // ★ OBS は何時間も開きっぱなしになる。切れたら必ず戻ること。
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(proto + "//" + location.host + "/overlay/ws?key=" + encodeURIComponent(key));
        ws.onopen = () => { retry = 0; note(true); };
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.type === "now-playing") { note(true, true); render(m.song, m.next); }
        };
        ws.onclose = () => {
            note(false);
            const wait = Math.min(30000, 1000 * Math.pow(2, retry++));  // 指数バックオフ、上限 30 秒
            setTimeout(connect, wait);
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
    }

    // 中継が黙って接続を切ることがあるので、こちらから生存確認を送る
    setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
    }, 45000);

    if(demo){
        note(true);
        addEventListener("message", (ev) => {
            if (ev.origin !== location.origin) return;
            const m = ev.data;
            if (!m || m.type !== "now-playing") return;
            seq = -1;
            note(m.connection !== "down", true);
            render(m.song, m.next);
        });
        try { parent.postMessage({ type: "np-preview-ready" }, location.origin); } catch {}
    } else {
        connect();
    }
})();
</script>
</body>
</html>`;
}

// GET /overlay
pages.get('/overlay', (c) => {
	// ★ テーマは**サーバ側で選んで差し込む**。
	//   DOM に data-theme を持たせて CSS 側で分岐すると、セレクタが
	//   .np[data-theme="card"] .np-title = 特異度 (0,3,0) になり、
	//   配信者の .np-title (0,1,0) が勝てなくなる。
	const bare = c.req.query('bare') === '1';
	const name = bare ? 'bare' : (c.req.query('theme') ?? 'default');
	const css = OVERLAY_THEMES[name] ?? OVERLAY_THEMES.default;
	return new Response(overlayHtml(css), { headers: HTML_HEADERS });
});

// オーバーレイの確認
const PREVIEW_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>オーバーレイの確認</title>
<!-- 空のアイコン。無いとコンソールに favicon.ico の 404 が出て、
    配信者が「壊れている」と誤解する -->
<link rel="icon" href="data:,">

<style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #14161b; color: #e6e9ef;
            font-family: "Yu Gothic UI", "Noto Sans JP", sans-serif; font-size: 14px; }
    .wrap { display: grid; grid-template-columns: 390px 1fr; min-height: 100vh; }
    @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } }
    .side { background: #1b1e26; border-right: 1px solid #2a2e38; padding: 16px;
            max-height: 100vh; overflow-y: auto; }
    .main { padding: 16px; min-width: 0; }
    h1 { font-size: 16px; margin: 0 0 6px; }
    .lead { font-size: 12px; color: #8b93a3; margin: 0 0 16px; line-height: 1.7; }
    fieldset { border: 1px solid #2a2e38; border-radius: 8px; margin: 0 0 14px; padding: 4px 12px 12px; }
    legend { font-size: 12px; color: #9aa3b2; padding: 0 5px; }
    label { display: block; font-size: 12px; color: #9aa3b2; margin: 9px 0 3px; }
    input[type=text], textarea {
        width: 100%; background: #12141a; color: #e6e9ef; border: 1px solid #2f3440;
        border-radius: 6px; padding: 7px 9px; font: inherit; }
    textarea { font-family: ui-monospace, "Consolas", monospace; font-size: 12px;
                line-height: 1.6; min-height: 200px; resize: vertical; }
    .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    button { background: #252a34; color: #e6e9ef; border: 1px solid #363c49;
            border-radius: 6px; padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; }
    button:hover { background: #2e3440; }
    button.on { background: #3b5bdb; border-color: #5c7cfa; color: #fff; }
    .hint { font-size: 11px; color: #6f7787; line-height: 1.7; margin-top: 9px; }
    .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
            margin-bottom: 10px; font-size: 12px; color: #8b93a3; }
    .stage { position: relative; width: 100%; overflow: hidden;
            border: 1px solid #2a2e38; border-radius: 8px; }
    /* ★ 背景は iframe と同じ 1920x1080 にして同じだけ縮める。
        inset:0 にすると等倍表示でスクロールしたときに背景だけ置いていかれる。 */
    .stage-bg, #frame { position: absolute; top: 0; left: 0;
                        width: 1920px; height: 1080px; transform-origin: top left; }
    .stage-bg { background-size: cover; background-position: center; }
    #frame { border: 0; }
    code { background: #12141a; border: 1px solid #2a2e38; border-radius: 4px;
            padding: 1px 5px; font-size: 12px; }
    .url { font-family: ui-monospace, monospace; font-size: 11px; }
</style>
</head>
<body>
<div class="wrap">

<div class="side">
    <h1>オーバーレイの確認</h1>
    <p class="lead">
        ここで書いた CSS を、OBS の「カスタムCSS」欄にそのまま貼れば同じ見た目になります。<br>
        曲は<strong>この画面の中だけの作り物</strong>です。実際の配信には影響しません。
    </p>

    <fieldset>
        <legend>いまの曲</legend>
        <label>曲名</label>
        <input type="text" id="title">
        <div class="row">
            <button data-len="群青">短い</button>
            <button data-len="アイドル新鮮な彼女はとても長い曲名">長い</button>
            <button data-len="これはとてもとても長い曲名で枠に到底収まらないことを確かめるためのもの">とても長い</button>
        </div>
        <label>歌手名（空にすると消えます）</label>
        <input type="text" id="artist">
        <label>キー（空にすると消えます）</label>
        <input type="text" id="key">
    </fieldset>

    <fieldset>
        <legend>次の曲</legend>
        <label>曲名（空にすると「次の曲」ごと消えます）</label>
        <input type="text" id="nextTitle">
        <label>歌手名</label>
        <input type="text" id="nextArtist">
    </fieldset>

    <fieldset>
        <legend>状態</legend>
        <div class="row">
            <button id="b-playing">歌っている</button>
            <button id="b-idle">待機中</button>
        </div>
        <div class="row">
            <button id="b-up">接続中</button>
            <button id="b-down">切断</button>
        </div>
        <p class="hint">
            待機中は <code>data-state="idle"</code>、切断は <code>data-connection="down"</code> です。<br>
            既定では待機中に何も表示されません（透過のまま）。
        </p>
    </fieldset>

    <fieldset>
        <legend>テーマ（URL の ?theme=）</legend>
        <div class="row" id="themes">
            <button data-theme="default">default</button>
            <button data-theme="card">card</button>
            <button data-theme="minimal">minimal</button>
            <button data-theme="bare">bare=1</button>
        </div>
        <p class="hint">bare=1 は既定 CSS を一切当てません。全部自分で書く人向けです。</p>
    </fieldset>

    <fieldset>
        <legend>カスタムCSS（OBS に貼るもの）</legend>
        <div class="row">
            <button data-sample="s-only-title">曲名だけ</button>
            <button data-sample="s-marquee-title">曲名をスクロール</button>
            <button data-sample="s-marquee-line">1 行でスクロール</button>
            <button data-sample="s-big">大きく金色</button>
            <button data-sample="s-next">次の曲を出す</button>
            <button id="b-clear">全部消す</button>
        </div>
        <label>打つそばから反映されます</label>
        <textarea id="css" spellcheck="false" placeholder=".np-title { font-size: 48px; }"></textarea>
        <p class="hint">
            効かないときは <code>.np .np-title</code> のように 1 段具体的にしてください。<br>
            内容はこのブラウザに保存されます（サーバには送っていません）。
        </p>
    </fieldset>

    <fieldset>
        <legend>OBS に貼る URL</legend>
        <label>オーバーレイの鍵（GET /me/overlay で取れるもの）</label>
        <input type="text" id="obskey" placeholder="ここに貼ると下の URL が完成します">
        <label>ブラウザソースの URL</label>
        <input type="text" id="obsurl" class="url" readonly>
        <div class="row"><button id="b-copy">コピー</button></div>
        <p class="hint">
            鍵は入れなくても構いません。プレビューは鍵を使いません。<br>
            入れた鍵もこのブラウザの中だけに保存されます。
        </p>
    </fieldset>
</div>

<div class="main">
    <div class="bar">
        <span>背景:</span>
        <button data-bg="dark">暗い</button>
        <button data-bg="light">明るい</button>
        <button data-bg="checker">市松</button>
        <button data-bg="green">緑（クロマキー）</button>
        <span style="margin-left:8px">画像 URL:</span>
        <input type="text" id="bgurl" style="width:180px" placeholder="https://…">
        <span style="margin-left:8px">大きさ:</span>
        <button data-zoom="fit">画面全体</button>
        <button data-zoom="one">等倍</button>
    </div>
    <div class="stage" id="stage">
        <div class="stage-bg" id="bg"></div>
        <iframe id="frame" title="overlay"></iframe>
    </div>
    <p class="hint">
        1920 × 1080 のブラウザソースを縮小して表示しています。
        文字の大きさの見え方は本番と同じです。
    </p>
</div>
</div>

<!-- CSS のひな型。type="text/plain" なので実行されない。
    ★ ここに置いているのは、JS の文字列に入れると改行のエスケープが
    二重になって読めなくなるため。 -->
<script type="text/plain" id="s-only-title">
.np-artist { display: none; }
.np-key    { display: none; }
</script>
<script type="text/plain" id="s-marquee-title">
/* 曲名だけを、枠からはみ出したときだけ流す */
.np-now { width: 520px; overflow: hidden; }

.np[data-title-overflow="true"] .np-title {
    display: inline-block;
    white-space: nowrap;
    --np-marquee-distance: var(--np-title-overflow-px);
    animation: np-marquee var(--np-title-duration) ease-in-out infinite alternate;
}
</script>
<script type="text/plain" id="s-marquee-line">
/* 「曲名 / 歌手名」を 1 本の文字列として流す */
.np { width: 520px; overflow: hidden; }
.np-title, .np-meta { display: inline; }
.np-artist::before { content: " / "; }
.np-key { display: none; }

.np[data-line-overflow="true"] .np-now {
    display: inline-block;
    white-space: nowrap;
    --np-marquee-distance: var(--np-line-overflow-px);
    animation: np-marquee var(--np-line-duration) ease-in-out infinite alternate;
}
</script>
<script type="text/plain" id="s-big">
.np-title { font-size: 56px; color: #ffd400; }
.np-meta  { font-size: 24px; }
</script>
<script type="text/plain" id="s-next">
.np-next { display: block; }
</script>

<script>
// ★ この <script> は TypeScript のテンプレートリテラルの中にある。
//   JS の文字列として改行を出したいときは \\n と 2 つ書くこと
//   (1 つだと TS 側で本物の改行になり、文字列が閉じずに壊れる)。
(() => {
    const $ = (s) => document.querySelector(s);
    const frame = $("#frame"), stage = $("#stage"), bgEl = $("#bg"), cssArea = $("#css");

    const S = {
        title: "夜に駆ける", artist: "YOASOBI", key: "+2",
        nextTitle: "群青", nextArtist: "YOASOBI",
        playing: true, connected: true,
        theme: "default", bg: "dark", bgUrl: "", zoom: "fit", css: "", obskey: "",
    };
    const SAVE = "np-preview";
    try { Object.assign(S, JSON.parse(localStorage.getItem(SAVE) || "{}")); } catch {}
    const save = () => { try { localStorage.setItem(SAVE, JSON.stringify(S)); } catch {} };

    // ── iframe に流し込む ────────────────────────────────
    function applyCss() {
        const d = frame.contentDocument;
        if (!d || !d.head) return;
        let st = d.getElementById("np-user-css");
        if (!st) {
            st = d.createElement("style");
            st.id = "np-user-css";
            // ★ 既定 CSS より後ろに入れる。同じ特異度なら後勝ちになる
            d.head.appendChild(st);
        }
        st.textContent = S.css;
    }

    function send() {
        const w = frame.contentWindow;
        if (!w) return;
        w.postMessage({
            type: "now-playing",
            connection: S.connected ? "up" : "down",
            song: S.playing ? { title: S.title, artist: S.artist, key: S.key } : null,
            next: S.nextTitle ? { title: S.nextTitle, artist: S.nextArtist } : null,
        }, location.origin);
    }

    function push() { applyCss(); send(); save(); }

    function reload() {
        const p = S.theme === "bare" ? "bare=1" : "theme=" + encodeURIComponent(S.theme);
        frame.src = "/overlay?demo=1&" + p;
    }

    addEventListener("message", (ev) => {
        if (ev.origin !== location.origin) return;
        if (ev.data && ev.data.type === "np-preview-ready") push();
    });

    // ── 1920x1080 を枠に合わせて縮める ───────────────────
    //
    // ★ 等倍 (zoom="one") も要る。縮めた絵では
    //   「この文字は配信で読めるのか」が分からない。
    function fit() {
        const one = S.zoom === "one";
        const k = one ? 1 : stage.clientWidth / 1920;
        const t = "scale(" + k + ")";
        frame.style.transform = t;
        bgEl.style.transform = t;
        stage.style.overflow = one ? "auto" : "hidden";
        stage.style.height = one ? "560px" : Math.round(1080 * k) + "px";
        mark("[data-zoom]", "zoom", S.zoom);
    }
    addEventListener("resize", fit);

    // ── 背景 ────────────────────────────────────────────
    const BG = {
        dark:  "background:#15171c",
        light: "background:#eef1f5",
        green: "background:#00b140",
        checker:
            "background-color:#8b8f98;" +
            "background-image:" +
                "linear-gradient(45deg,#4a4e58 25%,transparent 25%,transparent 75%,#4a4e58 75%)," +
                "linear-gradient(45deg,#4a4e58 25%,transparent 25%,transparent 75%,#4a4e58 75%);" +
            "background-size:32px 32px;background-position:0 0,16px 16px",
    };
    function paintBg() {
        bgEl.style.cssText = S.bgUrl
            ? "background-image:url(" + JSON.stringify(S.bgUrl) + ");background-size:cover;background-position:center"
            : (BG[S.bg] || BG.dark);
        mark("[data-bg]", "bg", S.bgUrl ? "" : S.bg);
        fit();   // ★ cssText で transform ごと消えるので入れ直す
    }

    // ── ボタンの選択状態 ─────────────────────────────────
    function mark(sel, attr, value) {
        document.querySelectorAll(sel).forEach((b) => {
            b.classList.toggle("on", b.dataset[attr] === value);
        });
    }
    function markState() {
        $("#b-playing").classList.toggle("on", S.playing);
        $("#b-idle").classList.toggle("on", !S.playing);
        $("#b-up").classList.toggle("on", S.connected);
        $("#b-down").classList.toggle("on", !S.connected);
    }

    // ── OBS の URL ──────────────────────────────────────
    function obsUrl() {
        const k = S.obskey.trim();
        const p = S.theme === "bare" ? "&bare=1"
            : S.theme === "default" ? "" : "&theme=" + S.theme;
        return location.origin + "/overlay?key=" + (k || "（ここに鍵）") + p;
    }
    function paintUrl() { $("#obsurl").value = obsUrl(); }

    // ── 入力を繋ぐ ──────────────────────────────────────
    const bindText = (id, field, after) => {
        const el = $("#" + id);
        el.value = S[field];
        el.addEventListener("input", () => { S[field] = el.value; (after || push)(); });
    };
    ["title", "artist", "key", "nextTitle", "nextArtist"].forEach((f) => bindText(f, f));
    bindText("css", "css");
    bindText("obskey", "obskey", () => { paintUrl(); save(); });
    bindText("bgurl", "bgUrl", () => { paintBg(); save(); });

    document.querySelectorAll("[data-len]").forEach((b) =>
        b.addEventListener("click", () => {
            S.title = b.dataset.len; $("#title").value = S.title; push();
        }));

    document.querySelectorAll("[data-theme]").forEach((b) =>
        b.addEventListener("click", () => {
            S.theme = b.dataset.theme;
            mark("[data-theme]", "theme", S.theme);
            paintUrl(); save(); reload();   // テーマはサーバが差し込むので読み直す
        }));

    document.querySelectorAll("[data-bg]").forEach((b) =>
        b.addEventListener("click", () => {
            S.bg = b.dataset.bg; S.bgUrl = ""; $("#bgurl").value = ""; paintBg(); save();
        }));

    document.querySelectorAll("[data-zoom]").forEach((b) =>
        b.addEventListener("click", () => { S.zoom = b.dataset.zoom; fit(); save(); }));

    document.querySelectorAll("[data-sample]").forEach((b) =>
        b.addEventListener("click", () => {
            const sample = ($("#" + b.dataset.sample).textContent || "").trim();
            S.css = [cssArea.value.trim(), sample].filter(Boolean).join("\\n\\n") + "\\n";
            cssArea.value = S.css;
            push();
        }));

    $("#b-clear").addEventListener("click", () => { S.css = ""; cssArea.value = ""; push(); });
    $("#b-playing").addEventListener("click", () => { S.playing = true; markState(); push(); });
    $("#b-idle").addEventListener("click", () => { S.playing = false; markState(); push(); });
    $("#b-up").addEventListener("click", () => { S.connected = true; markState(); push(); });
    $("#b-down").addEventListener("click", () => { S.connected = false; markState(); push(); });
    $("#b-copy").addEventListener("click", async () => {
        const b = $("#b-copy");
        try { await navigator.clipboard.writeText(obsUrl()); b.textContent = "コピーしました"; }
        catch { $("#obsurl").select(); b.textContent = "手で Ctrl+C してください"; }
        setTimeout(() => { b.textContent = "コピー"; }, 1800);
    });

    mark("[data-theme]", "theme", S.theme);
    markState(); paintBg(); paintUrl(); fit(); reload();
})();
</script>
</body>
</html>`;

pages.get(
	'/overlay/preview',
	() => new Response(PREVIEW_HTML, { headers: HTML_HEADERS }),
);

// ドック (カスタムブラウザドック)

const DOCK_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>歌枠ドック</title>
<style>
    :root { color-scheme: dark; }
    body {
        margin: 0; padding: 12px;
        font-family: "Noto Sans JP", "Yu Gothic UI", sans-serif;
        font-size: 14px; background: #16181d; color: #e7e9ee;
    }
    h2 { font-size: 15px; margin: 0 0 10px; font-weight: 600; }
    .card { background: #1f222a; border: 1px solid #2e323c; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
    input, button { font: inherit; border-radius: 6px; }
    input {
        width: 100%; box-sizing: border-box; padding: 8px 10px;
        background: #14161b; color: #e7e9ee; border: 1px solid #363b46;
    }
    button {
        padding: 8px 14px; border: 0; background: #4f6ef7; color: #fff;
        cursor: pointer; font-weight: 600;
    }
    button.ghost { background: #363b46; }
    button:disabled { opacity: .45; cursor: default; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row > input { flex: 1; }
    #code {
        font-size: 30px; font-weight: 700; letter-spacing: .12em;
        text-align: center; padding: 14px 0; font-family: ui-monospace, monospace;
    }
    .muted { color: #9aa1af; font-size: 12.5px; line-height: 1.6; }
    .hit { padding: 7px 9px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
    .hit:hover { background: #2b303a; border-color: #3a404c; }
    .hit b { font-weight: 600; }
    #nowBox { display: none; }
    #nowBox.on { display: block; }
    .ok { color: #4ade80; } .err { color: #fb7185; }
</style>
</head>
<body>

<!-- ① ペアリング -->
<div class="card" id="pairCard">
    <h2>接続</h2>
    <div id="code" class="muted">…</div>
    <p class="muted">
        この接続コードを、ブラウザで開いた管理画面に入力してください。<br>
        そのあと画面に出る 3 桁の確認番号を、下に入れます。
    </p>
    <div class="row">
        <input id="pin" inputmode="numeric" maxlength="3" placeholder="確認番号 3 桁">
        <button id="pinBtn">接続</button>
    </div>
    <p class="muted" id="pairMsg"></p>
</div>

<!-- ② 曲を探して出す -->
<div class="card" id="mainCard" style="display:none">
    <h2>今この曲</h2>
    <div id="nowBox" class="card" style="margin:0 0 10px">
        <div><b id="nowTitle"></b> <span class="muted" id="nowArtist"></span></div>
        <div class="row" style="margin-top:8px">
            <button class="ghost" id="clearBtn">表示を消す</button>
            <span class="muted" id="listeners"></span>
        </div>
    </div>
    <input id="q" placeholder="曲名を入力（2 文字以上）">
    <div id="hits" style="margin-top:8px"></div>
    <p class="muted" id="mainMsg"></p>
</div>

<script>
(() => {
    const API = location.origin;
    const KEY = "sst.dockToken";
    // ★ トークンは localStorage にだけ置き、画面には一切出さない。
    //   ドックは配信画面に映りうる場所なので、
    //   「接続済み」以上の情報を出さないこと。
    let token = null;
    try { token = localStorage.getItem(KEY); } catch {}

    const $ = (id) => document.getElementById(id);
    const show = (el, on) => { el.style.display = on ? "" : "none"; };

    async function api(path, opt = {}) {
        const h = Object.assign({}, opt.headers);
        if (token) h.authorization = "Bearer " + token;
        if (opt.body !== undefined) {
            h["content-type"] = "application/json";
            opt.body = JSON.stringify(opt.body);
        }
        const res = await fetch(API + path, Object.assign({}, opt, { headers: h }));
        let body = null; try { body = await res.json(); } catch {}
        return { status: res.status, body };
    }

    // ── ① ペアリング ─────────────────────────────
    let handle = null, code = null;

    async function startPairing() {
        const r = await api("/pair/start", { method: "POST" });
        if (r.status !== 201) { $("pairMsg").innerHTML = '<span class="err">接続を開始できませんでした。</span>'; return; }
        code = r.body.code;
        handle = r.body.handle;   // ★ 画面には出さない
        $("code").textContent = code;
        $("code").classList.remove("muted");
    }

    $("pinBtn").onclick = async () => {
        const pin = $("pin").value.trim();
        if (!/^\\d{3}$/.test(pin)) { $("pairMsg").innerHTML = '<span class="err">3 桁の数字を入れてください。</span>'; return; }
        $("pinBtn").disabled = true;
        const r = await api("/pair/confirm", { method: "POST", body: { code, handle, pin } });
        $("pinBtn").disabled = false;
        if (r.status === 201) {
            token = r.body.token;
            try { localStorage.setItem(KEY, token); } catch {}
            enter();
            return;
        }
        $("pin").value = "";
        const msg = r.status === 404
            ? "期限が切れました。ドックを開き直してください。"
            : (r.body && r.body.message) || "接続できませんでした。";
        $("pairMsg").innerHTML = '<span class="err">' + msg + "</span>";
        if (r.status === 404 || (r.body && r.body.error === "too many attempts")) startPairing();
    };

    // ── ② 本体 ──────────────────────────────────
    function enter() {
        show($("pairCard"), false);
        show($("mainCard"), true);
        refreshNow();
    }

    async function refreshNow() {
        const r = await api("/me/now-playing");
        if (r.status === 401) { signedOut(); return; }
        paintNow(r.body && r.body.song);
    }

    function paintNow(song) {
        if (!song) { $("nowBox").classList.remove("on"); return; }
        $("nowTitle").textContent = song.title;
        $("nowArtist").textContent = song.artist || "";
        $("nowBox").classList.add("on");
    }

    function signedOut() {
        token = null;
        try { localStorage.removeItem(KEY); } catch {}
        show($("mainCard"), false);
        show($("pairCard"), true);
        $("pairMsg").innerHTML = '<span class="err">接続が切れました。もう一度つないでください。</span>';
        startPairing();
    }

    // 曲の検索（曲マスタ）
    let timer = null;
    $("q").oninput = () => {
        clearTimeout(timer);
        const q = $("q").value.trim();
        if (q.length < 2) { $("hits").innerHTML = ""; return; }
        // 1 文字ごとに投げない
        timer = setTimeout(async () => {
            const r = await api("/songs/suggest?title=" + encodeURIComponent(q));
            const items = (r.body && r.body.items) || [];
            $("hits").innerHTML = "";
            if (!items.length) {
                // ★ ドック用トークンでは POST /songs を叩けない (full スコープが要る)。
                //   曲マスタは全配信者の共有資源で、訂正 API も無いため。
                //   ただしオーバーレイには songId 無しで出せるので、それは案内する。
                const d = document.createElement("div");
                d.className = "muted";
                d.textContent = "曲マスタに見つかりません。登録は管理画面から行ってください。";
                $("hits").append(d);
                return;
            }
            for (const s of items.slice(0, 8)) {
                const d = document.createElement("div");
                d.className = "hit";
                d.innerHTML = "<b></b> <span class='muted'></span>";
                d.querySelector("b").textContent = s.title;
                d.querySelector("span").textContent = s.artist || "";
                d.onclick = () => pick(s);
                $("hits").append(d);
            }
        }, 220);
    };

    async function pick(song) {
        $("mainMsg").textContent = "";
        // ★ オーバーレイと記録は**別々に**投げる。
        //   オーバーレイは見栄えなので即座に。記録は確実性が要るので
        //   失敗しても outbox に残り、あとで再送される。
        //   片方が失敗しても、もう片方は続ける。
        const over = api("/me/now-playing", {
            method: "POST",
            body: { title: song.title, artist: song.artist || null },
        });
        const rec = api("/me/performances", {
            method: "POST",
            body: [{ songId: song.id, clientId: "dock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) }],
        });
        const [o, p] = await Promise.all([over, rec]);
        if (o.status === 401 || p.status === 401) { signedOut(); return; }

        if (o.status === 200) {
            paintNow(o.body.song);
            $("listeners").textContent = "オーバーレイ " + (o.body.listeners ?? 0) + " 件に配信";
        } else {
            $("mainMsg").innerHTML = '<span class="err">オーバーレイを更新できませんでした。</span>';
        }
        if (p.status !== 201 && p.status !== 200) {
            $("mainMsg").innerHTML += ' <span class="err">記録に失敗しました（あとで再送されます）。</span>';
        } else {
            $("mainMsg").innerHTML += ' <span class="ok">記録しました。</span>';
        }
        $("q").value = "";
        $("hits").innerHTML = "";
    }

    $("clearBtn").onclick = async () => {
        const r = await api("/me/now-playing", { method: "DELETE" });
        if (r.status === 401) { signedOut(); return; }
        paintNow(null);
    };

    // ── 起動 ────────────────────────────────────
    // ★ 保存済みトークンが失効している可能性があるので、必ず 1 回確かめる。
    //   確かめずに本体を出すと、最初の「今これ」で初めて気づくことになる。
    (async () => {
        if (token) {
            const r = await api("/me");
            if (r.status === 200) { enter(); return; }
            token = null;
            try { localStorage.removeItem(KEY); } catch {}
        }
        startPairing();
    })();
})();
</script>
</body>
</html>`;

pages.get('/dock', () => new Response(DOCK_HTML, { headers: HTML_HEADERS }));
