# AGENTS.md — 项目说明（给 AI 协作者 / 开发者）

> 最后更新：2026-09-06。本文档描述当前真实架构，与 README.md / worker.js @ ba1377f 一致。
> 若文档与代码不一致，**以代码为准**，并顺手修正文档。

## 项目是什么

树莓社（苏州中学）社员数字化服务，部署于 **Cloudflare Workers**（域名 `nfc.raspjam.com`）：

- **H5 签到页**（`index.html`）：NFC 刷卡 / 二维码扫码签到、新卡登记、离线缓存
- **社员数据 API**：档案、查人、活动列表/详情、照片代理、证明文件代理
- **飞书多维表（Bitable）= 唯一数据源**；Worker 是安全代理层，**凭据只在 Worker 环境变量里**
- 微信小程序与腾讯云函数（member / activities / proofs）在**独立代码库**，经 `https.get` 中转调用本 Worker（本仓库不含）

## 技术栈与关键机制

- 原生 HTML/CSS/JS（H5 页面，无框架）+ Cloudflare Worker（`worker.js`，ESM，无依赖）
- **KV 缓存（SHUMEI_KV）**：读接口 KV 快照优先，避免频繁实时访问飞书（慢 + 有配额）
- KV 现有 6 类 key：`members_full` / `activity_records_v3` / `activity_projects_v1` / `file_catalog_v1`（惰性 60min）/ `avatar_img_<token>`（永久）/ `last_refresh_at`（30s 冷却）
- 附件（头像/活动照片/证明文件）走 **token 白名单 + 边缘缓存** 代理；`/api/photo` 用 cf.image 缩放（已开启），`/api/avatar` 与 `/api/file` 原样直出
- 快照刷新三通道：Cron（`30 * * * *`）兜底 → 飞书自动化「记录变更→HTTP /api/refresh」即时 → 读接口冷启动自愈（KV 空则实时拉取回填）

## 文件结构

```
index.html         # H5 签到页（单文件，内嵌 CSS+JS）
worker.js          # Worker 入口（路由+缓存+代理，文件头注释=接口全集）
wrangler.jsonc     # 部署配置（KV 绑定 / Cron / routes 自定义域名）
.wranglerignore    # 部署排除（*.md / *.csv / api-baseline / 审查交付 html）
AGENTS.md / README.md / CHANGELOG.md / DESIGN.md
docs/
  activity-api-plan.md               # 活动功能实现说明（小程序/云函数链路）
  dataflow-audit-2026-09-06.html     # 数据流全景图+接口案例+文档核对（不入部署）
  api-baseline/                      # API 基线抓包（敏感，git/wrangler 双忽略）
public/          # 旧静态数据（members.js 等，已废弃，仅历史参考）
start.sh         # 本地 HTTPS 静态服务器（Web NFC 需要安全上下文）
```

## 接口速览（13 条，详见 README.md）

| 类别 | 端点 | 数据源/缓存 |
|---|---|---|
| 读 | GET /api/members · /api/members/full | KV members_full（CDN 60s） |
| 读 | GET /api/members/detail?code= | KV + 边缘缓存 300s；禁查→found:false；avatarProxy；joinDate |
| 读 | GET /api/member?uid=｜q= | KV 优先 → 实时兜底飞书 |
| 读 | GET /api/activities · /api/activities/detail?id= | activity_projects_v1 + activity_records_v3 聚合；300s |
| 读 | GET /api/avatar | L1 1d + L2 KV 永久 |
| 读 | GET /api/photo | L1 7d（cf.image 缩放，不写 KV） |
| 读 | GET /api/proof-files | file_catalog_v1（60min 惰性） |
| 读 | GET /api/file | L1 7d（PDF 原样，不写 KV） |
| 写 | POST /api/checkin | 服务端重查人 + waitUntil 异步双写（WPS + 飞书群卡片） |
| 触发 | POST /api/refresh | Bearer 鉴权 + 30s 冷却，重建 4 快照 |

## 数据模型（飞书多维表，本 Worker 只用 4 张）

- 社员表 `tblepAz1PHnzwxA2`（FEISHU_TABLE_ID env）
- 活动项目表 `tbl30yargX7IZ1kc`（184 活动）
- 活动参与明细表 `tbl5Gr3qoPBatTmt`（~1138 条）
- 文件资料管理表 `tblO5pPurRqVPMR5`（社员证明等，~120 条）

> ⚠️ 字段名与飞书表头**逐字符一致**：如「封面图片（1张）」全角括号、无空格；列名「禁止查询」「社员证明」必须精确匹配。改飞书表头前先确认代码字段名。

## 开发 / 部署

1. 本地：`sh start.sh` 起 HTTPS 静态服务器（仅 H5 页面；API 走线上或降级 public/members.js）
2. Worker 改动无本地预览：`npx wrangler dev` 需要 KV/secret，简单改动直接看代码 + git
3. 部署：**Git 推送 GitHub → Cloudflare Workers Builds 自动部署**，无需本地 wrangler
4. **不要动 `wrangler.jsonc` 里的 routes（自定义域名）/ kv_namespaces / triggers(crons)**，否则覆盖远程配置

## 约定与坑

- **文档同步义务**：改动 Worker 后同步更新：worker.js 头注释（=接口全集）→ README（接口表/KV 表/版本表）→ CHANGELOG（版本条目）。改 H5 页面后更新 index.html 顶部 `APP_VERSION`/`APP_UPDATED_AT`。
- `docs/api-baseline/` 含社员全量原始数据（含登录密码列等敏感信息），**禁止推送 / 部署 / 外发**；对比接口用 `docs/api-baseline/00-grab.sh` 重放。
- 读接口缓存形态三种（KV 快照 / Cache API 边缘 / CDN 头），描述缓存时按接口精确说明，不要笼统写「全部 KV 优先」。
- 查人接口 `?q=` 查无返回 HTTP 500 + found:false 是**既有行为**（API 基线已记录），不要当 bug "修复" 成 404。
- 附件代理三层白名单互相隔离：avatar=成员快照、photo=活动项目快照、file=证明目录；不要跨域复用 token。
- Cloudflare Image Resizing **已开启**（/api/photo 依赖），README 旧版「不启用」表述已作废。
- 每次修改页面内容/样式/交互后，同步更新页面底部版本号（`APP_VERSION` 与 `APP_UPDATED_AT`）。

## 兼容性

- Android Chrome 89+：NFC 刷卡 ✓（Web NFC / NDEFReader）
- iOS Safari / 飞书内置浏览器：不支持 NFC，仅扫码
- 需要 HTTPS 安全上下文
