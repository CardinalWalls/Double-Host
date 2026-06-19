#!/usr/bin/env node
// 我是什么：Double-Host 的网页 agent。一个 Node 服务(无第三方依赖)，同时干两件事：
//   ① 给浏览器发一个聊天页面；② 后端接住用户输入 → 查 EvoMap recipe(门B) → 拼增强 prompt → 调 EvoMap 模型网关(门C)出答案。
// 何时用我：想在网页上直接用这个 agent 时。  跑：node --env-file=.env server.js  → 开 http://localhost:8080
// 全 EvoMap 原生：recipe 检索 + 模型生成都用 EvoMap。密钥只在后端(本进程)，绝不落到浏览器。
//   EVOMAP_TOKEN 没填就跳过检索；MODEL_KEY 没填则模型不可用。
'use strict';

const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT) || 8080;
// 模型后端：默认 EvoMap 自己的 LLM 网关(门C)。也可指到任意 OpenAI 兼容端点。
const MODEL_BASE_URL = process.env.MODEL_BASE_URL || 'https://api.evomap.ai/v1';
const MODEL_NAME = process.env.MODEL_NAME || 'evomap-deepseek-v4-flash';
const MODEL_KEY = process.env.MODEL_KEY || '';
// 经验检索：EvoMap 开发者 API(门B)
const EVOMAP_TOKEN = process.env.EVOMAP_TOKEN || '';
const EVOMAP_API = 'https://evomap.ai/developer/oauth';

function httpJson(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'User-Agent': 'Double-Host/0.2' }, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fetchRecipes(need) {
  if (!EVOMAP_TOKEN) return { recipes: [], note: '未配置 EVOMAP_TOKEN，跳过 EvoMap 检索' };
  try {
    const r = await httpJson('GET', `${EVOMAP_API}/recipes?q=${encodeURIComponent(need)}&limit=5`, { Authorization: 'Bearer ' + EVOMAP_TOKEN });
    if (r.status >= 400) return { recipes: [], note: `EvoMap ${r.status}` };
    const j = JSON.parse(r.body);
    return { recipes: j.recipes || j.data || [], note: '' };
  } catch (e) { return { recipes: [], note: 'EvoMap 请求失败: ' + e.message }; }
}

function buildPrompt(need, recipes) {
  const reuse = recipes.map((r) => `- 《${r.title || r.name || r.id}》：${(r.description || '').slice(0, 120)}`).join('\n');
  return [
    `用户需求：${need}`, '',
    reuse ? `EvoMap 网络里已有的可复用工作流(优先参考)：\n${reuse}` : '(EvoMap 暂无可复用经验，直接给最佳实践)', '',
    '请基于上面的经验，给出高质量、可直接落地的方案。',
  ].join('\n');
}

async function runModel(prompt) {
  if (!MODEL_KEY) throw new Error('MODEL_KEY 未设置(后端)');
  const r = await httpJson('POST', `${MODEL_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: 'Bearer ' + MODEL_KEY }, { model: MODEL_NAME, messages: [{ role: 'user', content: prompt }] });
  const j = JSON.parse(r.body);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ('(模型无输出) ' + r.body.slice(0, 200));
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Double-Host · EvoMap Agent</title><style>
*{box-sizing:border-box}body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px;background:#0d1117;color:#e6edf3}
h1{font-size:20px;margin:0 0 4px}.sub{color:#8b949e;font-size:13px;margin-bottom:20px}
textarea{width:100%;min-height:72px;padding:12px;border-radius:10px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font:inherit}
button{margin-top:10px;padding:10px 18px;border:0;border-radius:10px;background:#238636;color:#fff;font:inherit;cursor:pointer}
button:disabled{opacity:.5}.card{margin-top:18px;padding:14px;border:1px solid #30363d;border-radius:10px;background:#161b22}
.lbl{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}.recipe{font-size:13px;color:#7ee787}
.ans{border-color:#1f6feb}</style></head><body>
<h1>Double-Host · EvoMap 提示词增强 Agent</h1>
<div class="sub">输入需求 → 查 EvoMap 已有经验(recipe) → 拼成增强 prompt → EvoMap 模型(${MODEL_NAME})出方案。全程 EvoMap 原生。</div>
<textarea id="need" placeholder="例如：部署"></textarea><br>
<button id="go" onclick="ask()">增强并生成</button>
<div id="out"></div>
<script>
async function ask(){
  const need=document.getElementById('need').value.trim(); if(!need)return;
  const btn=document.getElementById('go'),out=document.getElementById('out');
  btn.disabled=true;out.innerHTML='<div class="card">思考中…</div>';
  try{
    const r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({need})});
    const j=await r.json();
    if(j.error){out.innerHTML='<div class="card">出错：'+j.error+'</div>';btn.disabled=false;return;}
    const recipes=(j.recipes||[]).map(x=>'· '+(x.title||x.id)).join('<br>')||'(本次无 EvoMap 命中：'+(j.note||'')+')';
    out.innerHTML='<div class="card"><div class="lbl">EvoMap 检索到的可复用经验</div><div class="recipe">'+recipes+'</div></div>'
      +'<div class="card"><div class="lbl">增强后的 prompt(进模型上下文的主角)</div><pre>'+esc(j.enhancedPrompt)+'</pre></div>'
      +'<div class="card ans"><div class="lbl">EvoMap 模型方案</div><pre>'+esc(j.answer)+'</pre></div>';
  }catch(e){out.innerHTML='<div class="card">请求失败：'+e.message+'</div>';}
  btn.disabled=false;
}
function esc(s){return String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model_key: MODEL_KEY ? 'set' : 'MISSING', evomap_token: EVOMAP_TOKEN ? 'set' : 'none', model: MODEL_NAME, model_base: MODEL_BASE_URL })); return;
  }
  if (req.method === 'POST' && req.url === '/api/ask') {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', async () => {
      try {
        const need = (JSON.parse(b || '{}').need || '').trim();
        if (!need) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'need 为空' })); return; }
        const { recipes, note } = await fetchRecipes(need);
        const enhancedPrompt = buildPrompt(need, recipes);
        const answer = await runModel(enhancedPrompt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recipes, note, enhancedPrompt, answer }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`Double-Host agent: http://localhost:${PORT}  (model:${MODEL_NAME} via ${MODEL_BASE_URL}, key:${MODEL_KEY ? 'ok' : 'MISSING'}, evomap_token:${EVOMAP_TOKEN ? 'set' : 'none'})`));
