// OBSに貼る2枚の画面

import { Hono } from 'hono';

export const pages = new Hono();

const HTML_HEADERS = {
	'content-type': 'text/html; charset=UTF-8',
	'cache-control': 'no-store',
} as const;

// オーバーレイ (ブラウザソース)

const OVERLAY_HTML = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Now Playing</title>
<style>
    /* ★ ブラウザソースは背景が透過される。
        body に色を置くと配信画面に黒い四角が出る。 */
    html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
    #box {
        font-family: "Noto Sans JP", "Yu Gothic UI", sans-serif;
        color: #fff;
        /* 配信画面の背景は何色か分からないので、必ず縁取りを入れる */
        text-shadow: 0 2px 6px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9);
        padding: 16px 22px;
        display: inline-block;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity .35s ease, transform .35s ease;
    }
    #box.on { opacity: 1; transform: none; }
    #title  { font-size: 34px; font-weight: 700; line-height: 1.25; }
    #sub    { font-size: 20px; font-weight: 500; opacity: .85; margin-top: 4px; }
    #key    { font-size: 17px; opacity: .7; margin-left: .6em; }
    /* 接続が切れていることを配信者だけが気づける程度に出す。
        視聴者に見えても意味不明にならないよう、文字は出さず点だけ。 */
    #dot {
        position: fixed; right: 6px; bottom: 6px;
        width: 7px; height: 7px; border-radius: 50%;
        background: #f43f5e; opacity: 0; transition: opacity .3s;
    }
    #dot.show { opacity: .8; }
    /* ─────────────────────────────────────────────────────
    ★ ?debug=1 のときだけ出る確認用パネル。

    オーバーレイは**曲が無いとき完全に透明**になる。
    配信画面に余計なものを出さないための正しい挙動だが、
    裏返すと「繋がっているが待機中」と「壊れている」が
    ブラウザで開いても見分けられない。
    OBS に貼る URL には付けず、動作確認のときだけ ?debug=1 を足す。
    ───────────────────────────────────────────────────── */
    #debug { display: none; }
    body.debug { background: #14161b; }
    body.debug #debug {
        display: block;
        position: fixed; left: 0; right: 0; bottom: 0;
        font-family: ui-monospace, "Yu Gothic UI", monospace;
        font-size: 13px; line-height: 1.7;
        color: #cbd2de; background: #1f222a;
        border-top: 1px solid #2e323c; padding: 10px 14px;
    }
    body.debug #box { outline: 1px dashed #3a404c; }
    #st { font-weight: 700; }
    #st.up { color: #4ade80; } #st.down { color: #fb7185; }
</style>
</head>
<body>
<div id="box"><div id="title"></div><div id="sub"></div></div>
<div id="dot"></div>
<div id="debug">
    <div>接続: <span id="st" class="down">未接続</span></div>
    <div>いまの曲: <span id="dsong">—</span></div>
    <div>最終受信: <span id="dat">—</span></div>
    <div style="opacity:.6;margin-top:6px">
        これは ?debug=1 を付けたときだけ出ます。OBS には付けずに貼ってください。
    </div>
</div>
<script>
(() => {
    const q = new URLSearchParams(location.search);
    const key = q.get("key") || "";
    const debug = q.get("debug") === "1";
    if (debug) document.body.classList.add("debug");
    const box = document.getElementById("box");
    const elTitle = document.getElementById("title");
    const elSub = document.getElementById("sub");
    const dot = document.getElementById("dot");
    const st = document.getElementById("st");
    const dsong = document.getElementById("dsong");
    const dat = document.getElementById("dat");

    function note(up, song, got) {
        if (!debug) return;
        st.textContent = up ? "接続中" : "切断";
        st.className = up ? "up" : "down";
        if (song !== undefined) {
            dsong.textContent = song
                ? song.title + (song.artist ? " / " + song.artist : "")
                : "（待機中 — 曲が設定されていません）";
        }
        if (got) dat.textContent = new Date().toLocaleTimeString();
    }

    let ws = null;
    let retry = 0;
    let seq = -1;

    function render(song) {
        note(true, song, true);
        if (!song) { box.classList.remove("on"); return; }
        // ★ 古い通知を捨てる。再接続直後に初回状態と配信が前後することがある
        if (song.seq != null && song.seq < seq) return;
        if (song.seq != null) seq = song.seq;
        elTitle.textContent = song.title;
        elSub.innerHTML = "";
        if (song.artist) elSub.append(song.artist);
        if (song.key) {
            const k = document.createElement("span");
            k.id = "key";
            k.textContent = "Key " + song.key;
            elSub.append(k);
        }
        box.classList.add("on");
    }

    function connect() {
        // ★ OBS は何時間も開きっぱなしになる。切れたら必ず戻ること。
        //   これを入れないと、ネットワークが一瞬揺れただけで
        //   以後ずっと更新されないオーバーレイが残る。
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(proto + "//" + location.host + "/overlay/ws?key=" + encodeURIComponent(key));

        ws.onopen = () => { retry = 0; dot.classList.remove("show"); note(true); };
        ws.onmessage = (ev) => {
            let m; try { m = JSON.parse(ev.data); } catch { return; }
            if (m.type === "now-playing") render(m.song);
        };
        ws.onclose = () => {
            dot.classList.add("show");
            note(false);
            // 指数バックオフ。上限 30 秒
            const wait = Math.min(30000, 1000 * Math.pow(2, retry++));
            setTimeout(connect, wait);
        };
        ws.onerror = () => { try { ws.close(); } catch {} };
    }

    // 中継が黙って接続を切ることがあるので、こちらから生存確認を送る
    setInterval(() => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
    }, 45000);

    connect();
})();
</script>
</body>
</html>`;

pages.get(
	'/overlay',
	() => new Response(OVERLAY_HTML, { headers: HTML_HEADERS }),
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
