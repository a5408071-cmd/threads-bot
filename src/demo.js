/**
 * Meta の審査（App Review）の画面録画用のデモ画面（docs/app-review.md）。鍵（?key=CRON_KEY）が要る。
 * 「Threads でログイン」→ キーワード検索 → 結果から 1 件選んで返信を投稿、の流れを 1 ページで見せる。
 * 審査前は /keyword_search が自分の投稿しか返さないが、録画はそれで構わない。
 */
function demoHtml({ base, key }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const k = esc(key);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Threads 運用ツール（デモ）</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#222;line-height:1.6}h1{font-size:1.3rem}section{border:1px solid #ddd;border-radius:12px;padding:16px;margin:16px 0}button{padding:10px 16px;border:0;border-radius:8px;background:#1e3a8a;color:#fff;font-size:1rem;cursor:pointer}input,textarea{width:100%;padding:10px;border:1px solid #bbb;border-radius:8px;font-size:1rem;box-sizing:border-box}.post{border-bottom:1px solid #eee;padding:10px 0}.post small{color:#666}.sel{background:#eef5ff}#msg{color:#1e3a8a;white-space:pre-wrap}</style></head>
<body>
<h1>Threads 運用ツール（本人専用）</h1>
<section><h2>1. ログイン</h2><p>所有者の Threads アカウントで OAuth ログインします。</p><a href="${esc(base)}/oauth/start?key=${k}"><button type="button">Threads でログイン</button></a></section>
<section><h2>2. キーワード検索（threads_keyword_search）</h2>
<form id="f"><input id="q" placeholder="例: ゴルフ" value="ゴルフ"> <p><button type="submit">検索</button></p></form>
<div id="list"></div></section>
<section><h2>3. 返信を投稿（threads_manage_replies）</h2><p>上の一覧から投稿を選び、返信を書いて投稿します。</p>
<p>選択中: <span id="chosen">（未選択）</span></p>
<textarea id="t" rows="3" placeholder="返信の本文"></textarea><p><button id="send" type="button">返信を投稿</button></p><p id="msg"></p></section>
<script>
const KEY=${JSON.stringify(key)};let chosen=null;
document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const q=document.getElementById('q').value;const r=await fetch('/demo/search?key='+encodeURIComponent(KEY)+'&q='+encodeURIComponent(q));const j=await r.json();const el=document.getElementById('list');el.innerHTML='';if(!j.posts||!j.posts.length){el.textContent='結果なし'+(j.error?'（'+j.error+'）':'');return;}for(const p of j.posts){const d=document.createElement('div');d.className='post';d.innerHTML='<b>@'+p.username+'</b> <small>'+(p.timestamp||'')+'</small><br>'+p.text.replace(/</g,'&lt;');d.onclick=()=>{document.querySelectorAll('.post').forEach(x=>x.classList.remove('sel'));d.classList.add('sel');chosen=p;document.getElementById('chosen').textContent='@'+p.username+'「'+p.text.slice(0,40)+'」';};el.appendChild(d);}});
document.getElementById('send').addEventListener('click',async()=>{if(!chosen){alert('投稿を選んでください');return;}const text=document.getElementById('t').value;const r=await fetch('/demo/reply?key='+encodeURIComponent(KEY),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({replyToId:chosen.id,text})});const j=await r.json();document.getElementById('msg').textContent=j.ok?'投稿しました: '+(j.permalink||j.mediaId):'失敗: '+(j.error||'');});
</script></body></html>`;
}

module.exports = { demoHtml };
