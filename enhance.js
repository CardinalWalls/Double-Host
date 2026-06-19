#!/usr/bin/env node
// 我是什么：Double-Host 的核心。把「用户需求」变成「带 EvoMap 复用经验的增强 prompt」，再交给模型出结果。
// 何时用我：demo 的主入口。node enhance.js "你的需求"
// 依赖：Node 18+，无第三方包。密钥从环境变量读（别硬编码）。
'use strict';

const https = require('https');

const DORO_URL = process.env.DORO_BASE_URL || 'https://proxy.yetian.online/sub2api/v1';
const DORO_MODEL = process.env.DORO_MODEL || 'gpt-5.5';
const DORO_KEY = process.env.CODEX_DORO_KEY || '';
const EVOMAP_TOKEN = process.env.EVOMAP_TOKEN || '';
const EVOMAP_API = 'https://evomap.ai/developer/oauth';

function httpJson(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({ 'User-Agent': 'Double-Host/0.1' }, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 1) 去 EvoMap 检索可复用的 recipe（没有 token 就返回空，demo 照样能跑）
async function fetchReuse(userNeed) {
  if (!EVOMAP_TOKEN) return { recipes: [], note: '(无 EVOMAP_TOKEN，跳过检索)' };
  const r = await httpJson('GET', `${EVOMAP_API}/recipes?q=${encodeURIComponent(userNeed)}&limit=5`,
    { Authorization: 'Bearer ' + EVOMAP_TOKEN });
  if (r.status >= 400) return { recipes: [], note: `(EvoMap ${r.status}: ${r.body.slice(0, 120)})` };
  try { const j = JSON.parse(r.body); return { recipes: j.recipes || j.data || [], note: '' }; }
  catch { return { recipes: [], note: '(EvoMap 返回非 JSON)' }; }
}

// 2) 把检索到的经验拼成增强 prompt —— 这段文字就是真正进模型上下文的主角
function buildEnhancedPrompt(userNeed, recipes) {
  const reuse = recipes
    .map((r) => `- 《${r.title || r.name || r.id}》：${(r.description || '').slice(0, 120)}`)
    .join('\n');
  return [
    `用户需求：${userNeed}`,
    '',
    reuse ? `网络里已有的可复用工作流（优先参考，别重造）：\n${reuse}` : '（暂无可复用经验，直接给最佳实践）',
    '',
    '请基于上面的经验，给出高质量、可直接落地的解决方案。',
  ].join('\n');
}

// 3) 交给模型（doro）出结果
async function runModel(prompt) {
  if (!DORO_KEY) throw new Error('CODEX_DORO_KEY 未设置');
  const r = await httpJson('POST', `${DORO_URL.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: 'Bearer ' + DORO_KEY },
    { model: DORO_MODEL, messages: [{ role: 'user', content: prompt }] });
  const j = JSON.parse(r.body);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || JSON.stringify(j).slice(0, 300);
}

async function main() {
  const userNeed = process.argv.slice(2).join(' ').trim() || '写一个零停机的部署脚本';
  console.log('需求：', userNeed, '\n');

  const { recipes, note } = await fetchReuse(userNeed);
  console.log(`EvoMap 检索：命中 ${recipes.length} 条 recipe ${note}`);
  recipes.forEach((r, i) => console.log(`  ${i + 1}. ${r.title || r.id}`));

  const prompt = buildEnhancedPrompt(userNeed, recipes);
  console.log('\n=== 增强后的 prompt（进模型上下文的主角）===\n' + prompt + '\n');

  console.log('=== 模型（' + DORO_MODEL + '）输出 ===');
  console.log(await runModel(prompt));
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
