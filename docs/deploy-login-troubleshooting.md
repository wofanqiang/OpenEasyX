# VPS 部署后没有登录界面的排查与修复

## 1. 结论先行（根因）

**VPS 上运行的不是你改过的代码，而是上游官方镜像。**

`compose.yaml` 原本的写法是：

```yaml
image: ghcr.io/raccommode/open-easyx:latest
pull_policy: always
```

这两行的含义是：从**上游作者（raccommode）**的公共镜像仓库拉取官方镜像，并且**每次 `docker compose up` 都强制重新拉取**。因此：

- 你本地加的登录功能（`server/auth.ts`、`src/Login.tsx`、`src/AuthGate.tsx`）只存在于本地目录和你的 GitHub 仓库 `wofanqiang/OpenEasyX`，**从未进入容器**；
- 更糟的是 `pull_policy: always` 会让你即使手动 build 过，下次 `up` 时又被官方镜像覆盖回去；
- 官方镜像不含任何应用级认证，所以打开就是 Home —— 行为完全自洽，不是 bug。

> 裸机部署（`npm start`）的情况不同，见 §3.2：那是"前端产物未重新构建"导致。

---

## 2. 一条命令定性

在 VPS 上执行：

```bash
curl -s -o /dev/null -w "me=%{http_code}\n" http://127.0.0.1:3210/api/auth/me
```

| 返回 | 含义 | 处置 |
|---|---|---|
| **404** | 后端根本没有 `/api/auth/me` 路由 → 跑的是**旧版本/官方镜像** | 按 §3 重新部署 |
| **401** | 后端是新版且门禁生效 → 前端产物问题（未 build / 浏览器缓存） | 按 §3.2 / §4 |
| **200** | 已有有效会话（浏览器带 Cookie 才会） | 正常，换无痕窗口再测 |

再确认容器内是否真的有登录代码：

```bash
docker exec open-easyx sh -c 'ls -l /app/server/auth.ts 2>&1'
# "No such file or directory" => 官方镜像，确认根因
```

---

## 3. 修复

### 3.1 Docker Compose（最常见）

`compose.yaml` 已改为**从源码构建**：

```yaml
build:
  context: .
image: ${EASYX_IMAGE:-open-easyx:local}
# 已移除 pull_policy: always
```

在 VPS 上：

```bash
cd /path/to/OpenEasyX
git pull                       # 拿到含登录功能的提交
docker compose build           # 从源码构建（需要 ≥2GB 内存，见下方注意）
docker compose up -d
docker compose logs -f open-easyx | head -40
```

首次启动日志里应出现（任选其一）：

```
Admin password initialized from EASYX_ADMIN_PASSWORD.
No admin password configured. Generated initial password: xxxxxxxx
```

> **内存提醒**：`npm run build` = `tsc --noEmit && vite build`，峰值内存常超过 1GB。若 VPS 只有 1GB，构建可能 OOM。**推荐改用 §3.3 的 GitHub Actions 构建**，VPS 只负责 pull。

**`.env` 必设**（与 compose.yaml 同目录）：

```bash
EASYX_SESSION_SECRET=$(openssl rand -hex 32)
EASYX_ADMIN_PASSWORD=你的强密码   # ≥8 位，仅首次启动生效
EASYX_EMBEDDED_SUBTITLE_WORKER=false
EASYX_ENABLE_BROWSER_LOGIN=false
```

若走 HTTPS 反代，另设 `EASYX_COOKIE_SECURE=true`（或让反代透传 `X-Forwarded-Proto: https`）。

### 3.2 裸机部署（`npm start`）

裸机时网关是 `dist/web` 下的**构建产物**，而 `dist/` 被 `.gitignore` 忽略，所以 `git pull` **不会**更新前端。必须重新构建：

```bash
git pull
npm ci
npm run build          # 生成 dist/web（含 AuthGate/Login）
npm start
```

典型症状：后端已是新版（`/api/auth/me` 返回 401），但前端仍是旧 bundle，页面直接渲染 `App`。由于 `/api/dashboard` 被 401 拦截，`App` 会一直停在 “Starting Open EasyX…” 而不是显示数据 —— 这可与 §3.1 的"官方镜像"场景区分开。

### 3.3 用 GitHub Actions 构建（低内存 VPS 推荐）

仓库已新增 `.github/workflows/docker-image.yml`：push 到 `main` 即在 GitHub runner 上构建并推送 `ghcr.io/wofanqiang/open-easyx:latest`。

步骤：

1. 推送代码到 `wofanqiang/OpenEasyX` 的 `main` 分支；
2. 到仓库 **Actions** 页确认工作流跑绿；
3. 首次推送后把包可见性改为公开（或配置 ghcr 登录）：
   GitHub 仓库页右侧 **Packages → open-easyx → Package settings → Change visibility → Public**；
4. VPS 上把 `compose.yaml` 切到该镜像（或直接设环境变量）：

```bash
# 方式一：改 compose.yaml 的两行（文件里已有注释说明）
#   image: ghcr.io/wofanqiang/open-easyx:latest
#   pull_policy: always

# 方式二：不动文件，用环境变量覆盖
echo 'EASYX_IMAGE=ghcr.io/wofanqiang/open-easyx:latest' >> .env
docker compose pull && docker compose up -d
```

之后每次更新只需：`git push` → 等 Actions → VPS 上 `docker compose pull && docker compose up -d`。

---

## 4. 部署后仍不弹登录页？

按顺序排除：

1. **浏览器缓存**：旧 JS bundle 被强缓存。用无痕窗口，或 DevTools → Network 勾 “Disable cache” 后硬刷新。确认 `index-*.js` 里能搜到 `api/auth/me`。
2. **已有有效 Cookie**：`/api/auth/me` 返回 200 就直接放行（会话 30 天）。点顶栏退出按钮，或清掉 `easyx_session` Cookie。
3. **走了 `/library` 等路由**：`main.tsx` 对 `LibraryApp` 与 `App` 一视同仁地包在 `AuthGate` 内，理论上都会拦截；若只有某个路由不拦，说明该 VPS 上的 bundle 仍是旧的。

---

## 5. 验证清单

```bash
# 1. 未登录：应 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/items          # 401
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/auth/me        # 401
# 2. 健康检查与静态资源放行（SPA 外壳可加载，避免门禁死锁）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/health         # 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/                   # 200
# 3. 登录拿 Cookie
curl -s -c c.txt -X POST -H 'content-type: application/json' \
  -d '{"password":"你的密码"}' http://127.0.0.1:3210/api/auth/login               # {"ok":true}
# 4. 带 Cookie 访问
curl -s -o /dev/null -w "%{http_code}\n" -b c.txt http://127.0.0.1:3210/api/items # 200
# 5. 密码哈希不得外泄
curl -s -b c.txt http://127.0.0.1:3210/api/settings | grep -c admin_password_hash # 0
```

---

## 6. 边界提醒

登录是**门禁不是沙箱**：通过后插件仍在主进程内以宿主权限运行。公网暴露时，TLS（Caddy 反代，见 `deploy/Caddyfile`）+ 强密码 + 及时更新，仍是必要的组合防线。
