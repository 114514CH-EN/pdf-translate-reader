# 服务器版：前端 Vercel + 后台自己的服务器

和 workspace 的 files-server 一样的结构：

```
浏览器 ──https──▶ Vercel（前端页面）
                    │  /api/*  转发（vercel.json 的 rewrites）
                    ▼
        pdf-api.miku-api.com（Cloudflare Tunnel）
                    │
                    ▼
        你的服务器：Docker 里的后台（FastAPI + SQLite + PyMuPDF，端口 8003）
                    │  登录时把账号密码交给
                    ▼
        www.miku-api.com/api/auth（workspace 的账号系统）
```

- 后台不放 Vercel：一份文档要翻译好几分钟，PDF、页面图和数据库要长期保存，Vercel 的无服务器函数做不到
- 只有 `.env` 里 `PDFTR_ALLOWED_USERS` 列出的 workspace 用户能登录；别人打开只看到登录页，所有 `/api` 请求都返回 401
- 登录后是一个 HttpOnly 的会话 cookie（默认 30 天），图片、PDF 原文这些请求也会自动带上
- `/api` 的响应一律 `Cache-Control: private`，`vercel.json` 也关掉了 CDN 缓存，文档内容不会被 Vercel 缓存给别人
- 本机的 exe / run.bat 完全不受影响（不设 `PDFTR_AUTH_URL` 就是原来的本机版）

## 1. 服务器：起容器

```bash
git clone https://github.com/114514CH-EN/pdf-translate-reader.git /opt/pdf-translate
cd /opt/pdf-translate
cp deploy/.env.example deploy/.env
nano deploy/.env        # 填用户名，两个密钥用 openssl rand -hex 32 生成
docker compose -f deploy/docker-compose.yml up -d --build
curl http://127.0.0.1:8003/api/health   # 应返回 {"ok":true, ... "cloud":true}
```

`.env` 里四项都要填：

| 变量 | 说明 |
|---|---|
| `PDFTR_AUTH_URL` | workspace 登录接口，`https://www.miku-api.com/api/auth` |
| `PDFTR_ALLOWED_USERS` | 允许登录的 workspace 用户名（逗号分隔，不区分大小写） |
| `PDFTR_SESSION_SECRET` | 签名登录 cookie，`openssl rand -hex 32` |
| `PDFTR_SECRET_KEY` | 加密保存翻译 API Key，`openssl rand -hex 32`；以后别改，改了要重新填 Key |

`.env` 没配好登录时，镜像里的 `PDFTR_REQUIRE_AUTH=1` 会让后台拒绝所有请求，不会误开放。

数据在 `deploy/data/`（文档、译文、笔记、设置、自动备份），重建容器不会丢。

## 2. Cloudflare Tunnel：加一个子域名

和 files-server 一样在仪表盘操作：Zero Trust → Networks → Tunnels → 你的隧道 → Public Hostname → Add a public hostname：

- Subdomain：`pdf-api`
- Domain：`miku-api.com`
- Type：`HTTP`
- URL：`localhost:8003`

验证：`curl https://pdf-api.miku-api.com/api/health`

> 用别的子域名的话，同时改 `frontend/vercel.json` 里 rewrites 的地址。

## 3. Vercel：导入前端

1. Vercel → Add New → Project → 选 GitHub 仓库 `114514CH-EN/pdf-translate-reader`
2. **Root Directory 选 `frontend`**（其余设置由 `frontend/vercel.json` 提供：Vite、`npm run build`、输出 `dist`）
3. Deploy。以后往 main 推送会自动重新部署
4. 想用自己的域名（例如 `pdf.miku-api.com`）：项目 Settings → Domains 添加，再按提示在 Cloudflare DNS 加一条 CNAME（灰色云朵，不走 Cloudflare 代理）

打开网站 → 用 workspace 账号登录 → 在 ⚙ 设置里填翻译 API（API Key 加密存在服务器上）。桌宠版是同一个网址加 `/pet`。

## 4. 把电脑上的文档库搬上去（可选）

1. 关掉电脑上的程序，服务器上 `docker compose -f deploy/docker-compose.yml stop`
2. 把电脑 `data\pdf_translate.db` 和 `data\uploads\` 整个文件夹（还有 `data\pet\`，如果换过桌宠形象）复制到服务器的 `deploy/data/`
3. `docker compose -f deploy/docker-compose.yml start`
4. 在网页的设置里**重新填一次 API Key**：电脑上的 Key 是用 Windows 账户加密的，换到服务器解不开

## 更新

```bash
cd /opt/pdf-translate && git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

前端由 Vercel 自动部署。页面和后台版本对不上时，页面顶部会提示，等两边都更新完刷新即可。

## 安全说明

- 后台端口只绑定 `127.0.0.1:8003`，外面只能经 Cloudflare Tunnel 访问
- 登录失败太多会暂停 5 分钟（后台和 workspace 各自限流）
- 想取消某人的权限：从 `PDFTR_ALLOWED_USERS` 删掉并重启容器，他已有的登录立刻失效
- 想让所有人重新登录：换一个 `PDFTR_SESSION_SECRET` 并重启
- 「退出程序」按钮在服务器版里换成了「退出登录」；`/api/shutdown` 在服务器版不可用
- 桌宠「从网址导入形象」和「拉取模型列表」会由服务器去访问你填的地址——只有登录后的你能用
