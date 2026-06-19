#!/usr/bin/env node
// 我是什么：Double-Host 网页 agent 的薄后端 + 前端。三件事：
//   ① 实时搜 EvoMap recipe（门B，后端代理，浏览器没法直连因为 EvoMap 不开 CORS）；
//   ② code sandbox：选中一条 recipe → 让 EvoMap 模型（门C）按它当指令，流式把代码一行行写出来；
//   ③ EvoMap 搜索 token 自动续期（1h 过期就用 refresh_token 换新的，搜索不会变暗）。
// 跑：node --env-file=.env server.js  → http://localhost:8080
// 密钥只在后端：EVOMAP_TOKEN/EVOMAP_REFRESH_TOKEN/EVOMAP_CLIENT_ID（门B）、MODEL_KEY（门C）。都不进浏览器、不进 git。
'use strict';

const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT) || 8080;
const MODEL_BASE_URL = process.env.MODEL_BASE_URL || 'https://api.evomap.ai/v1';
const MODEL_NAME = process.env.MODEL_NAME || 'evomap-deepseek-v4-flash';
const MODEL_KEY = process.env.MODEL_KEY || '';
const EVOMAP_API = 'https://evomap.ai';

// 门B token 在内存里管理，401 时用 refresh 续期
let accessToken = process.env.EVOMAP_TOKEN || '';
let refreshToken = process.env.EVOMAP_REFRESH_TOKEN || '';
const CLIENT_ID = process.env.EVOMAP_CLIENT_ID || '';

function req(method, urlStr, headers, body, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({ 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }, headers || {});
    if (data != null && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data != null) h['Content-Length'] = Buffer.byteLength(data);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h }, (res) => {
      if (onChunk) { res.on('data', (c) => onChunk(c)); res.on('end', () => resolve({ status: res.statusCode })); res.on('error', reject); return; }
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

async function refreshAccess() {
  if (!refreshToken || !CLIENT_ID) return false;
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }).toString();
  const r = await req('POST', EVOMAP_API + '/oauth/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  if (r.status >= 400) return false;
  try { const j = JSON.parse(r.body); if (j.access_token) { accessToken = j.access_token; if (j.refresh_token) refreshToken = j.refresh_token; return true; } } catch {}
  return false;
}

// 搜 recipe（带 401 自动续期重试一次）
async function searchRecipes(q) {
  const call = () => req('GET', `${EVOMAP_API}/developer/oauth/recipes?q=${encodeURIComponent(q)}&limit=8`, { Authorization: 'Bearer ' + accessToken });
  try {
    let r = await call();
    if (r.status === 401 && await refreshAccess()) r = await call();
    if (r.status >= 400) return { ok: false, status: r.status, recipes: [] };
    const j = JSON.parse(r.body); return { ok: true, recipes: j.recipes || j.data || [] };
  } catch (e) { return { ok: false, status: 0, recipes: [], err: String(e && e.message || e) }; }
}

// pretext：把选中的 recipe 当“要遵循的 skill”，让模型按它写代码
function codePretext(need, recipe) {
  const r = recipe || {};
  return [
    '你是一个按 EvoMap recipe（可复用工作流）写代码的 agent。',
    '下面这条 recipe 就是你要遵循的指令蓝本，照它的思路产出**可直接运行的代码**。',
    '',
    '【要遵循的 recipe】',
    '标题：' + (r.title || r.id || '（无）'),
    '说明：' + (r.description || '（无）'),
    '',
    '【用户需求】' + (need || '按上面的 recipe 给一个最小可运行示例'),
    '',
    '要求：直接输出代码，用 ``` 代码块包裹，必要时加简短注释。先给主文件，再给运行说明。不要长篇大论。',
  ].join('\n');
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Double-Host · EvoMap 搜索 + 代码沙盒</title><style>
*{box-sizing:border-box}body{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:980px;margin:0 auto;padding:20px;background:#0d1117;color:#e6edf3}
h1{font-size:19px;margin:0 0 2px}.sub{color:#8b949e;font-size:12px;margin-bottom:16px}
.row{display:flex;gap:8px}input{flex:1;padding:10px 12px;border-radius:9px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font:inherit}
button{padding:10px 16px;border:0;border-radius:9px;background:#238636;color:#fff;font:inherit;cursor:pointer}button:disabled{opacity:.5}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}@media(max-width:760px){.cols{grid-template-columns:1fr}}
.panel{border:1px solid #30363d;border-radius:10px;background:#161b22;padding:12px;min-height:120px}
.lbl{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.rec{padding:8px;border:1px solid #21262d;border-radius:8px;margin-bottom:8px;cursor:pointer}.rec:hover{border-color:#1f6feb}
.rec b{color:#7ee787;font-weight:600}.rec p{margin:4px 0 0;color:#8b949e;font-size:12px}
.code{background:#0a0c10;border-radius:8px;padding:12px;font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;min-height:300px;color:#c9d1d9}
.cur::after{content:'▋';color:#58a6ff;animation:b 1s steps(1) infinite}@keyframes b{50%{opacity:0}}
.hint{color:#8b949e;font-size:12px}</style></head><body>
<h1>Double-Host · EvoMap 搜索 + 代码沙盒</h1>
<div class="sub">实时搜 EvoMap 网络里的可复用 recipe（门B）→ 选一条 → EvoMap 模型（${MODEL_NAME}，门C）按它当指令，<b>流式把代码写出来</b>。</div>
<div class="row"><input id="q" placeholder="搜需求，如：部署 / 回测 / CI" onkeydown="if(event.key==='Enter')search()"><button id="sb" onclick="search()">搜索</button></div>
<div class="cols">
  <div class="panel"><div class="lbl">EvoMap recipe（点一条 → 生成代码）</div><div id="list"><div class="hint">输入关键词搜索 EvoMap 网络。</div></div></div>
  <div class="panel"><div class="lbl">代码沙盒 · 看模型实时写</div><div id="code" class="code"><span class="hint">点左边一条 recipe，这里会一行行写出代码。</span></div></div>
</div>
<script>
let chosen=null;
async function search(){
  const q=document.getElementById('q').value.trim();if(!q)return;
  const sb=document.getElementById('sb'),list=document.getElementById('list');
  sb.disabled=true;list.innerHTML='<div class="hint">搜索中…</div>';
  try{
    const r=await fetch('/api/search?q='+encodeURIComponent(q));const j=await r.json();
    if(!j.recipes||!j.recipes.length){list.innerHTML='<div class="hint">没搜到（'+(j.note||'')+'）。换个短词试试，如“部署”。</div>';sb.disabled=false;return;}
    list.innerHTML=j.recipes.map((x,i)=>'<div class="rec" onclick="gen('+i+')"><b>'+esc(x.title||x.id)+'</b><p>'+esc((x.description||'').slice(0,90))+'</p></div>').join('');
    window._recs=j.recipes;
  }catch(e){list.innerHTML='<div class="hint">搜索失败：'+e.message+'</div>';}
  sb.disabled=false;
}
async function gen(i){
  const rec=window._recs[i];chosen=rec;
  const code=document.getElementById('code');code.classList.add('cur');code.textContent='';
  try{
    const r=await fetch('/api/code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({need:document.getElementById('q').value.trim(),recipe:rec})});
    const reader=r.body.getReader();const dec=new TextDecoder();
    for(;;){const {done,value}=await reader.read();if(done)break;code.textContent+=dec.decode(value,{stream:true});code.scrollTop=code.scrollHeight;}
  }catch(e){code.textContent+='\\n[出错] '+e.message;}
  code.classList.remove('cur');
}
function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
</script></body></html>`;

function readBody(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); req.on('error', () => res('')); }); }

const server = http.createServer(async (request, response) => {
  const url = request.url || '/';
  if (request.method === 'GET' && (url === '/' || url === '/index.html')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(PAGE); return;
  }
  if (request.method === 'GET' && url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, model: MODEL_NAME, model_key: MODEL_KEY ? 'set' : 'MISSING', evomap_token: accessToken ? 'set' : 'none', can_refresh: !!(refreshToken && CLIENT_ID) }));
    return;
  }
  if (request.method === 'GET' && url.startsWith('/api/search')) {
    const q = new URL(url, 'http://x').searchParams.get('q') || '';
    const out = await searchRecipes(q);
    response.writeHead(out.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ recipes: out.recipes, note: out.ok ? '' : ('EvoMap ' + out.status) }));
    return;
  }
  if (request.method === 'POST' && url === '/api/code') {
    if (!MODEL_KEY) { response.writeHead(500); response.end('MODEL_KEY 未设置'); return; }
    let payload = {}; try { payload = JSON.parse(await readBody(request) || '{}'); } catch {}
    const prompt = codePretext(payload.need, payload.recipe);
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    let buf = '';
    try {
      await req('POST', `${MODEL_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
        { Authorization: 'Bearer ' + MODEL_KEY },
        { model: MODEL_NAME, stream: true, messages: [{ role: 'user', content: prompt }] },
        (chunk) => {
          buf += chunk.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const d = line.slice(5).trim();
            if (d === '[DONE]') continue;
            try { const j = JSON.parse(d); const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (t) response.write(t); } catch {}
          }
        });
    } catch (e) { try { response.write('\n[stream error] ' + e.message); } catch {} }
    response.end();
    return;
  }
  response.writeHead(404); response.end('not found');
});

server.listen(PORT, () => console.log(`Double-Host: http://localhost:${PORT}  (model:${MODEL_NAME}, evomap_token:${accessToken ? 'set' : 'none'}, refresh:${refreshToken && CLIENT_ID ? 'on' : 'off'})`));
