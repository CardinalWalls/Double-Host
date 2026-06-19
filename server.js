#!/usr/bin/env node
// 我是什么：Double-Host 的网页 agent + 最小只读后端。一个 Node 服务(无第三方依赖)，给浏览器发页面，并代理三件事：
//   /api/search  —— 实时搜 EvoMap recipe/gene(门B，服务端握 token，绕开浏览器 CORS)
//   /api/ask     —— 需求→检索→拼增强 prompt→EvoMap 模型出方案(非流式)
//   /api/build   —— 代码沙箱：让 EvoMap 模型【流式】吐一个自包含前端，浏览器实时"打字"出代码并 iframe 渲染
// 跑：node --env-file=.env server.js  → http://localhost:8080
// 密钥只在后端：EVOMAP_TOKEN(门B) + MODEL_KEY(门C，sk-evomap-…)。前端不碰密钥。
'use strict';

const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT) || 8080;
const MODEL_BASE_URL = process.env.MODEL_BASE_URL || 'https://api.evomap.ai/v1';
const MODEL_NAME = process.env.MODEL_NAME || 'evomap-deepseek-v4-flash';
const MODEL_KEY = process.env.MODEL_KEY || '';
const EVOMAP_TOKEN = process.env.EVOMAP_TOKEN || '';
const EVOMAP_API = 'https://evomap.ai/developer/oauth';

function httpJson(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'User-Agent': 'Double-Host/0.3' }, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 门B：搜 recipe / gene（type=recipes|genes）
async function evomapSearch(q, type) {
  if (!EVOMAP_TOKEN) return { items: [], note: '未配置 EVOMAP_TOKEN' };
  const path = type === 'genes' ? `/genes?limit=10` : `/recipes?q=${encodeURIComponent(q)}&limit=10`;
  try {
    const r = await httpJson('GET', EVOMAP_API + path, { Authorization: 'Bearer ' + EVOMAP_TOKEN });
    if (r.status >= 400) return { items: [], note: `EvoMap ${r.status}` };
    const j = JSON.parse(r.body);
    return { items: j.recipes || j.genes || j.data || [], note: '' };
  } catch (e) { return { items: [], note: e.message }; }
}

function buildPrompt(need, recipes) {
  const reuse = recipes.map((r) => `- 《${r.title || r.name || r.id}》：${(r.description || '').slice(0, 120)}`).join('\n');
  return [`用户需求：${need}`, '', reuse ? `EvoMap 网络里已有的可复用工作流(优先参考)：\n${reuse}` : '(无可复用经验)', '',
    '请基于上面的经验，给出高质量、可直接落地的方案。'].join('\n');
}

async function runModel(prompt) {
  if (!MODEL_KEY) throw new Error('MODEL_KEY 未设置(后端)');
  const r = await httpJson('POST', `${MODEL_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: 'Bearer ' + MODEL_KEY }, { model: MODEL_NAME, messages: [{ role: 'user', content: prompt }] });
  const j = JSON.parse(r.body);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ('(无输出) ' + r.body.slice(0, 200));
}

// 把 EvoMap 模型的 SSE 流原样转发给浏览器（代码沙箱用）
function streamModel(messages, clientRes) {
  const u = new URL(`${MODEL_BASE_URL.replace(/\/+$/, '')}/chat/completions`);
  const payload = JSON.stringify({ model: MODEL_NAME, stream: true, messages });
  const up = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MODEL_KEY, 'Content-Length': Buffer.byteLength(payload) } },
    (upRes) => {
      clientRes.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      upRes.on('data', (c) => clientRes.write(c));
      upRes.on('end', () => clientRes.end());
    });
  up.on('error', (e) => { try { clientRes.writeHead(502); clientRes.end('upstream error: ' + e.message); } catch (_) {} });
  up.write(payload); up.end();
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Double-Host · EvoMap</title><style>
*{box-sizing:border-box}body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:20px;background:#0d1117;color:#e6edf3}
h1{font-size:19px;margin:0 0 2px}.sub{color:#8b949e;font-size:12px;margin-bottom:14px}
.tabs{display:flex;gap:8px;margin-bottom:14px}.tab{padding:7px 14px;border:1px solid #30363d;border-radius:8px;background:#161b22;color:#8b949e;cursor:pointer}.tab.on{background:#238636;color:#fff;border-color:#238636}
.panel{display:none}.panel.on{display:block}
input,textarea{width:100%;padding:10px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font:inherit}
button{margin-top:8px;padding:9px 16px;border:0;border-radius:8px;background:#238636;color:#fff;font:inherit;cursor:pointer}button:disabled{opacity:.5}
.card{margin-top:14px;padding:12px;border:1px solid #30363d;border-radius:8px;background:#161b22}
.lbl{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:13px ui-monospace,monospace}
.recipe{font-size:13px;color:#7ee787}
.sandbox{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}@media(max-width:760px){.sandbox{grid-template-columns:1fr}}
.code{height:380px;overflow:auto;background:#0a0c10}.think{color:#8b949e;font-size:12px;max-height:90px;overflow:auto;margin-bottom:8px;white-space:pre-wrap}
iframe{width:100%;height:380px;border:1px solid #30363d;border-radius:8px;background:#fff}
</style></head><body>
<h1>Double-Host · EvoMap</h1>
<div class="sub">门B 实时搜索经验 · 门C 模型生成 · 代码沙箱实时展示写代码过程。后端握密钥，前端不碰。</div>
<div class="tabs">
  <div class="tab on" data-p="search" onclick="tab('search')">🔍 搜索经验</div>
  <div class="tab" data-p="ask" onclick="tab('ask')">💡 增强问答</div>
  <div class="tab" data-p="build" onclick="tab('build')">⚡ 代码沙箱</div>
</div>

<div class="panel on" id="p-search">
  <input id="sq" placeholder="搜 EvoMap recipe，例如：部署 / deploy / test" onkeydown="if(event.key==='Enter')doSearch()">
  <button onclick="doSearch()">搜索</button>
  <div id="sout"></div>
</div>

<div class="panel" id="p-ask">
  <textarea id="aneed" rows="2" placeholder="需求，例如：给 Node 服务加优雅退出"></textarea>
  <button id="abtn" onclick="doAsk()">增强并生成</button>
  <div id="aout"></div>
</div>

<div class="panel" id="p-build">
  <input id="bneed" placeholder="要做的前端，例如：一个待办清单 / 一个计算器" onkeydown="if(event.key==='Enter')doBuild()">
  <button id="bbtn" onclick="doBuild()">生成并实时渲染</button>
  <div class="sandbox">
    <div><div class="lbl">写代码过程（实时）</div><div class="think" id="bthink"></div><div class="card code"><pre id="bcode"></pre></div></div>
    <div><div class="lbl">沙箱预览</div><iframe id="bframe" sandbox="allow-scripts"></iframe></div>
  </div>
</div>

<script>
function tab(p){document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.p===p));document.querySelectorAll('.panel').forEach(x=>x.classList.toggle('on',x.id==='p-'+p));}
function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}

async function doSearch(){
  const q=sq.value.trim(); if(!q)return; sout.innerHTML='<div class="card">搜索中…</div>';
  const r=await fetch('/api/search?q='+encodeURIComponent(q)); const j=await r.json();
  const items=(j.items||[]).map(x=>'<div class="card"><b class="recipe">《'+esc(x.title||x.name||x.id)+'》</b><br><span style="color:#8b949e;font-size:13px">'+esc((x.description||'').slice(0,160))+'</span></div>').join('');
  sout.innerHTML=items||'<div class="card">无命中（'+esc(j.note||'')+'）</div>';
}

async function doAsk(){
  const need=aneed.value.trim(); if(!need)return; abtn.disabled=true; aout.innerHTML='<div class="card">思考中…</div>';
  try{const r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({need})});const j=await r.json();
    if(j.error){aout.innerHTML='<div class="card">出错：'+esc(j.error)+'</div>';}else{
      const rec=(j.recipes||[]).map(x=>'· '+esc(x.title||x.id)).join('<br>')||'(无命中)';
      aout.innerHTML='<div class="card"><div class="lbl">EvoMap 经验</div><div class="recipe">'+rec+'</div></div><div class="card"><div class="lbl">方案</div><pre>'+esc(j.answer)+'</pre></div>';}
  }catch(e){aout.innerHTML='<div class="card">失败：'+esc(e.message)+'</div>';}
  abtn.disabled=false;
}

async function doBuild(){
  const need=bneed.value.trim(); if(!need)return; bbtn.disabled=true;
  bthink.textContent=''; bcode.textContent=''; bframe.srcdoc='';
  let code='', think='';
  try{
    const r=await fetch('/api/build',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({need})});
    const reader=r.body.getReader(), dec=new TextDecoder(); let buf='';
    while(true){
      const {done,value}=await reader.read(); if(done)break;
      buf+=dec.decode(value,{stream:true}); const lines=buf.split('\\n'); buf=lines.pop();
      for(const line of lines){
        const s=line.trim(); if(!s.startsWith('data:'))continue;
        const d=s.slice(5).trim(); if(d==='[DONE]')continue;
        try{const o=JSON.parse(d); const dl=o.choices&&o.choices[0]&&o.choices[0].delta||{};
          if(dl.reasoning_content){think+=dl.reasoning_content; bthink.textContent=think; bthink.scrollTop=bthink.scrollHeight;}
          if(dl.content){code+=dl.content; bcode.textContent=code; bcode.parentElement.scrollTop=bcode.parentElement.scrollHeight;}
        }catch(_){}
      }
    }
    // 抽出 html 代码块（没有则整体当 html）
    const m=code.match(/\`\`\`(?:html)?\\s*([\\s\\S]*?)\`\`\`/i);
    bframe.srcdoc=(m?m[1]:code).trim();
  }catch(e){bthink.textContent='失败：'+e.message;}
  bbtn.disabled=false;
}
</script></body></html>`;

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true, model_key: MODEL_KEY ? 'set' : 'MISSING', evomap_token: EVOMAP_TOKEN ? 'set' : 'none', model: MODEL_NAME });
  }
  // 门B 实时搜索代理
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const r = await evomapSearch(url.searchParams.get('q') || '', url.searchParams.get('type') || 'recipes');
    return send(res, 200, r);
  }
  // 非流式增强问答
  if (req.method === 'POST' && url.pathname === '/api/ask') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', async () => {
      try { const need = (JSON.parse(b || '{}').need || '').trim(); if (!need) return send(res, 400, { error: 'need 为空' });
        const { items } = await evomapSearch(need, 'recipes');
        const answer = await runModel(buildPrompt(need, items));
        send(res, 200, { recipes: items, answer });
      } catch (e) { send(res, 500, { error: e.message }); }
    });
    return;
  }
  // 代码沙箱：流式生成自包含前端
  if (req.method === 'POST' && url.pathname === '/api/build') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', async () => {
      try {
        const need = (JSON.parse(b || '{}').need || '').trim();
        if (!need) return send(res, 400, { error: 'need 为空' });
        if (!MODEL_KEY) return send(res, 500, { error: 'MODEL_KEY 未设置' });
        const { items } = await evomapSearch(need, 'recipes');
        const hint = items.slice(0, 3).map((r) => '- ' + (r.title || r.id)).join('\n');
        const sys = '你是前端工程师。只输出一个【自包含的 single-file HTML】(内联 CSS/JS，不引外部资源)，实现用户要的东西。用 ```html 代码块包裹，代码块外不要任何解释。';
        const user = `做一个：${need}` + (hint ? `\n\n（EvoMap 网络里相关的经验，可参考思路）：\n${hint}` : '');
        streamModel([{ role: 'system', content: sys }, { role: 'user', content: user }], res);
      } catch (e) { try { send(res, 500, { error: e.message }); } catch (_) {} }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`Double-Host: http://localhost:${PORT}  (model:${MODEL_NAME}, key:${MODEL_KEY ? 'ok' : 'MISSING'}, evomap_token:${EVOMAP_TOKEN ? 'set' : 'none'})`));
