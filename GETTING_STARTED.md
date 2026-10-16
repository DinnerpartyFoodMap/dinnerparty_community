# 快速上手（给完全初学者）

> 本项目分为 **前端**（`frontend/`）和 **后端**（`backend/`）两个部分，各自独立运行。  
> 首次运行请按顺序完成以下步骤。

---

## 0-1. 安装 Node.js / npm

npm 是 Node.js 自带的包管理工具，安装 Node.js 后自动附带。

1. 根据系统下载安装：
   - **macOS**：打开 https://nodejs.org，下载 `.pkg`（LTS 版），双击安装
   - **Windows**：参考视频教程 👉 [BV1sK41187iw](https://www.bilibili.com/video/BV1sK41187iw)
2. 安装完成后验证（macOS 用「终端 Terminal」，Windows 用「命令提示符 CMD」或「PowerShell」）：

```bash
node -v   # 应输出 v22.x.x 或更高（构建 Android/iOS 应用的 Capacitor 8 需要 Node 22+）
npm -v    # 应输出类似 10.x.x
```

---

## 0-2. 启动 Redis（后端依赖）

后端使用 Redis 存储登录会话，需要本地先运行 Redis。

**macOS（推荐用 Homebrew）：**

```bash
# 若未安装 Homebrew，先在终端执行：
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install redis
brew services start redis   # 后台常驻运行
```

**Windows：**

推荐使用 [Memurai](https://www.memurai.com/)（Redis 的 Windows 原生版，免费开发版）：

1. 前往 https://www.memurai.com/get-memurai 下载安装包
2. 双击安装，安装后会自动作为 Windows 服务在后台运行
3. 或者使用 WSL2（Windows Subsystem for Linux）并在其中按 macOS 方式安装 Redis

**验证（两平台通用）：**

```bash
redis-cli ping   # 应输出 PONG
```

> **Windows CMD / PowerShell** 中 `redis-cli` 需要在 Memurai 安装目录下执行，或将其加入系统 PATH。

---

## 0-3. 安装后端依赖并启动

**macOS 终端 / Windows PowerShell / CMD 通用：**

```bash
cd backend
npm install       # 安装所有依赖（只需首次或依赖变更时执行）
npm start         # 启动后端服务，默认监听 http://127.0.0.1:7000（可用 backend/.env 的 PORT/HOST 修改）
```

### 可选：启用语义搜索与“幽幽子特别推荐”

复制 `backend/.env.example` 为 `backend/.env`，并只在后端环境中填写：

```bash
SILICONFLOW_API_KEY=你的SiliconFlow密钥
DEEPSEEK_API_KEY=你的DeepSeek密钥
```

项目使用 `Qwen/Qwen3-Embedding-4B` 的 1024 维输出和 SQLite 内的 `sqlite-vec` 余弦 KNN。首次为历史地点生成向量时运行：

```bash
cd backend
npm run vectors:backfill
```

新增地点和语义字段变更会异步更新向量；失败项保持待补刷状态，并由后台任务定时重试。只修改图片或坐标不会重复调用 Embedding API。

### 可选：启用日记算法

日记生成、位置消歧和合并由私有算法 API 提供；前端及手工记录沿用本项目。根据 `backend/.env.journey.example` 配置服务地址和凭据，详见 [日记算法服务接入](backend/modules/journeys/doc/ALGORITHM_SERVICE.md)。仅设置上面的 `DEEPSEEK_API_KEY` 不再直接启用日记算法。

> **Windows 用户**：推荐使用 **PowerShell** 或 **Windows Terminal**，避免使用老版 CMD（部分颜色输出可能乱码，但不影响运行）。

---

## 0-4. 安装前端依赖并启动

新开一个终端窗口/标签页：

**macOS 终端 / Windows PowerShell / CMD 通用：**

```bash
cd frontend
npm install       # 安装所有依赖（只需首次或依赖变更时执行）
npm run dev       # 启动前端开发服务器，默认地址见终端输出（通常为 http://localhost:5173）
```

> `npm run dev` 启动的是 **Vite 开发服务器**，支持热更新，修改代码后浏览器自动刷新。  
> 启动后在浏览器打开终端输出的地址（如 `http://localhost:5173`）即可看到页面。
>
> 前端通过 `VITE_BACKEND_URL` 访问后端（开发时见 `frontend/.env.local`，默认 `http://127.0.0.1:7000`）。
> 若后端地址不同，请在 `frontend/.env.local` 中修改：
>
> ```bash
> VITE_BACKEND_URL=http://你的后端地址:端口
> ```

### 高德地图配置

参照 `frontend/.env.example`，在已被 Git 跟踪的 `frontend/.env.local` 中填写 `VITE_AMAP_JS_KEY`（公开的 Web 端 JS API key），并提交该文件。Vite 在本地开发、网页与移动端构建以及 GitHub Actions 构建时都会自动读取它，无需配置 Actions secret；前端 JS 源码不硬编码 key。

参照 `backend/.env.example`，仅在被 Git 忽略的 `backend/.env` 或后端部署环境中设置 `AMAP_JS_CODE`（JS API 安全密钥）。

代码不提供凭证回退：缺少 `AMAP_JS_CODE` 时高德代理返回 503；缺少 `VITE_AMAP_JS_KEY` 时前端显示配置错误。修改后重启后端和前端开发服务，生产网页与移动端需重新构建。此前已提交或泄露的 `AMAP_JS_CODE` 应在高德控制台更换。

---

## 常用命令速查

| 位置 | 命令 | 作用 |
|------|------|------|
| `backend/` | `npm install` | 安装/更新后端依赖 |
| `backend/` | `npm start` | 启动后端（生产/调试） |
| `frontend/` | `npm install` | 安装/更新前端依赖 |
| `frontend/` | `npm run dev` | 启动前端开发服务器 |
| `frontend/` | `npm run build` | 打包前端（生产部署用） |
| `frontend/` | `npm run build:mobile` | 打包 Android/iOS 应用内置的前端资源 |
| `frontend/` | `npm run cap:sync` | 构建并同步到原生工程 |

---

## 生产域名与 CDN

默认网站地址为 `https://www.dinnerparty.cc`，保留 `https://dinnerparty.cc` 的访问与跨域支持，不强制跳转。网页和 App 的正式构建配置分别在 `frontend/.env.production`、`frontend/.env.mobile`，接口使用 `https://www.dinnerparty.cc/backend`，新生成的分享链接使用 `https://www.dinnerparty.cc`。

生产服务器的 `backend/.env` 需要同步设置以下两项，并重启后端（该文件不纳入 Git）：

```dotenv
FRONTEND_BASE_URL=https://www.dinnerparty.cc
QQ_BOT_PUBLIC_WEB_URL=https://www.dinnerparty.cc
```

更新网页后重新构建并部署 `frontend/dist/`；移动端需重新构建、同步和发布，新配置才会进入 App。旧版 App 仍使用原域名，因此原域名的 HTTPS、接口与代理路由也要保留。

CDN / 反向代理配置在项目之外，需要为新旧域名保留这些路由：

- `/backend/` 转发到后端并去掉 `/backend` 前缀，传递 `Host`、`X-Forwarded-Proto` 和 `X-Forwarded-Prefix: /backend`；绕过 CDN 缓存，避免缓存登录、用户和动态业务数据。
- `/_AMapService/` 转发到后端同名路径，保留查询参数并绕过 CDN 缓存。
- `/p/` 转发到后端地点分享页，不能回退为前端首页；绕过 CDN 缓存以保持分享卡片内容更新。
- 其余前端路由保留 SPA 回退。首页不做长期缓存，带内容哈希的静态资源可长期缓存。

如高德、CARTO 或图片服务设置了域名 / Referer 白名单，追加 `www.dinnerparty.cc` 并保留原域名。原有 `cn.dinnerparty.cc:2053` 图片地址及历史图片兼容逻辑继续保留。

## Android / iOS 应用

应用基于同一套前端，通过 Capacitor 打包。环境准备、Android Studio 调试、云端 iOS 构建与 TestFlight 配置见 [MOBILE_DEVELOPMENT.md](MOBILE_DEVELOPMENT.md)。
