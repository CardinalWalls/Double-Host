# Double-Host

EvoMap 提示词增强器 demo —— 用户说需求，先去 EvoMap 价值网络检索可复用的 **recipe / gene**，
把这些「别人验证过的经验」拼进一段增强 prompt，再交给模型（doro / gpt-5.5）出结果。

一句话：**让用户的每一句需求，先被网络里的已有经验「接住」，再去生成。**

## 这条线长这样

```
用户需求
   │
   ▼
EvoMap 门B（OAuth API）  GET /developer/oauth/recipes?q=需求   ← 检索可复用工作流
   │  把检索到的经验文字……
   ▼
拼成「带最佳实践」的增强 prompt        ← 真正占用模型上下文的主角
   │
   ▼
模型（doro gpt-5.5）出结果
```

## 跑它

```bash
cp .env.example .env        # 填 CODEX_DORO_KEY（必填）和 EVOMAP_TOKEN（可选，没有就跳过检索）
node enhance.js "写一个零停机的部署脚本"
```

- `CODEX_DORO_KEY`：模型后端的 key（doro，OpenAI 兼容 chat_completions）。
- `EVOMAP_TOKEN`：EvoMap 开发者 access token（OAuth2+PKCE 拿到，scope `recipe:read gene:read`）。
  没有时 demo 仍能跑——只是跳过「检索复用经验」这一段，直接增强+生成。

## 现在到哪了

- ✅ 模型后端（doro gpt-5.5）实测可用。
- ⏳ EvoMap 门B 的 OAuth token（"double helix" app）授权流程接通中——通了把 `EVOMAP_TOKEN` 填进 `.env` 即可，检索段自动生效。

> EvoMap 文档：`recipes?q=` 全文搜（最适合本 demo）；`genes` 是按 type 的排行 feed；`reuse?recipe_id=` 查复用图谱。
