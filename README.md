# 树莓社社员服务（shumeinfc-projects）

树莓社（苏州中学）社员数字化服务后端 + 前端，部署于 Cloudflare Workers 边缘网络。
覆盖：**NFC 刷卡/二维码扫码签到 H5**、**社员档案（DeepMei App / 网页 / 微信小程序）**、**社团活动展示**、**社员证明文件**。
核心是**对飞书多维表（Bitable）的安全代理**：凭据只在 Worker 端，读接口对社员数据做 **KV 快照缓存**，避免频繁实时访问飞书；附件（头像/照片/证明 PDF）经 Worker 代理 + 边缘缓存 + token 白名单后对外可稳定访问。

> 文档基线：本文档与 `worker.js` 当前代码一致。
> 配套：更新日志见 `CHANGELOG.md`；活动功能的完整实现说明见 `docs/activity-api-plan.md`；线上接口真实返回快照见 `docs/api-baseline/`（**含社员全量原始数据，禁止推送与部署**）。

## 架构

```
┌─ 浏览器 H5 (index.html) ─────────────────────────────┐
│  localStorage 缓存层：单条登记缓存 + 24h 批量离线缓存   │
└──────────────┬───────────────────────────────────────┘
               ▼
┌─ DeepMei Android App ──────────────┐
│  GET /api/members/full → 24h 本地快照 │
└──────────────┬─────────────────────┘
               ▼
┌─ Cloudflare Worker (worker.js) ─────────────────────────────┐
│  读接口 → KV 快照/边缘缓存（秒回，几乎不碰飞书）                │
│    GET /api/members/full       全量原始记录（App 快照用）      │
│    GET /api/members            卡号/识别码/姓名映射（H5 离线缓存）│
│    GET /api/members/detail     单人脱敏档案（网页/小程序档案）  │
│    GET /api/members/find-code  识别码找回（多字段强匹配）       │
│    GET /api/member             uid/q 查人（KV 优先+实时兜底）  │
│    GET /api/activities         活动列表（筛选/分页/facets）    │
│    GET /api/activities/detail  活动详情（只出统计与照片）       │
│    GET /api/avatar             头像代理直链（边缘+KV 永久）    │
│    GET /api/photo              活动照片代理 + 缩放（边缘 7 天） │
│    GET /api/proof-files        社员证明文件目录（证明页用）     │
│    GET /api/file               社员证明附件代理（PDF 原样）     │
│  写/实时接口 → 直接飞书 / webhook                              │
│    POST /api/checkin           签到：服务端重查人 + 写 WPS + 发飞书通知 │
│  触发刷新接口                                                  │
│    POST /api/refresh           重建 4 快照（飞书自动化调用）    │
└──────────────┬────────────────────────────────────────────┘
               │
        KV（SHUMEI_KV）6 类 key
          ├─ members_full              社员全量快照
          ├─ activity_records_v3       活动参与记录（人→活动）
          ├─ activity_projects_v1      活动项目完整快照
          ├─ file_catalog_v1           文件资料表目录快照（惰性 60min）
          ├─ avatar_img_<token>        头像图片字节（永久）
          └─ last_refresh_at           refresh 冷却时间戳
               ▲
               │ Cron（每小时第 30 分钟）自动重建 4 快照（兜底）
               │ 飞书自动化「记录变更 → HTTP」触发 refresh（即时）
               │ 冷启动自愈：读接口 KV 未命中 → 实时拉飞书并回填
               │
┌─ 微信小程序（会员卡/档案/活动/证明页）──┐   ┌─ 飞书多维表 ─ 唯一数据源 ─┐
│  wx.cloud.callFunction（域名未备案）   │   │  社员表 / 活动项目表 /      │
│  云函数 member / activities / proofs  │◄──│  参与明细表 / 文件资料表    │
│  → https.get Worker → 图片转存 cloud://│   └──────────────────────────┘
└──────────────────────────────────────┘
```

## 功能

- **NFC 刷卡签到 / 二维码扫码签到** — 识别社员卡号或识别码，新卡登记自动关联
- **离线可用** — H5 24h 批量缓存、App 24h 快照；查询三级降级（单条 → 批量 → 在线）
- **飞书通知 + WPS 同步** — 签到成功由 Worker 异步推送飞书机器人卡片 + 写入 WPS 多维表
- **社员隐私开关** — 飞书表勾选「禁止查询」，公开档案页查不到（签到/App 快照不受影响）
- **社员档案** — `/api/members/detail` 单人脱敏档案（无登录密码/QQ/电话/身份证/卡号），供网页与小程序档案页；含活动参与记录
- **活动列表/详情/照片墙** — 小程序「活动」tab：184 个活动项目、年份/类型筛选、封面色块占位、图片墙缩略图转存云存储（只出统计数字，不出参与人名单）
- **社员证明文件** — 小程序证明页：文件目录 + PDF 下载；资格判定（发布时间 ≥ 入社日期）在微信云函数本地完成
- **社员数据 KV 缓存** — 读接口秒回，飞书只被 Cron / 自动化 / 冷启动自愈访问

## 接口清单（14 条）

| 方法 | 路径 | 数据源 | 说明 |
|---|---|---|---|
| GET | `/api/members/full` | KV 快照 | 全量原始记录（含 `record_id`、附件 tmp_url），供 App 24h 本地快照 |
| GET | `/api/members` | KV 快照 | 卡号/识别码/姓名映射（cardMap/barcodeMap/infoMap），供 H5 离线缓存；CDN 60s |
| GET | `/api/members/detail?code=<识别码>` | KV 快照 + Cache API 300s | 单人**脱敏**档案（含 activities 参与记录、avatarProxy、joinDate）；勾选「禁止查询」→ `found:false`（不缓存，即时生效）；CORS * |
| GET | `/api/members/find-code?name=&grade=&clazz=&dept=&seq=` | KV 快照（no-store） | 识别码找回：姓名 + 至少两项补充信息强匹配；勾选「禁止查询」→ `found:false`；唯一命中才回「社员识别码」+ 社员编号，多命中只出脱敏候选，响应不缓存 |
| GET | `/api/member?uid=<卡号>` | KV 优先+实时兜底 | 按卡号/识别码/认读码查人（签到用）；查无返回 HTTP 500 + `found:false`（既有行为） |
| GET | `/api/member?q=<姓名>` | KV 优先+实时兜底 | 姓名/别名/编号/识别码/认读码/序号搜索（精确匹配） |
| GET | `/api/avatar?token=<file_token>` | 边缘缓存 1d + KV 永久 | 头像图片代理直链；白名单=成员快照「头像/个人照片」token；飞书删图仍可访问 |
| GET | `/api/activities` | 双 KV 聚合 + Cache 300s | 活动列表：year（4 位/`early`≤2023）/type/q/limit/offset 筛选 + facets 全量筛选项；cover 为 photo w=400 直链 |
| GET | `/api/activities/detail?id=<recordId>` | 双 KV 聚合 + Cache 300s | 活动详情：**无 participants 字段**（隐私定案）；stats 参与人次/总时长/志愿时长；photos thumb w400/full w1200 |
| GET | `/api/photo?token=&w=` | 边缘缓存 7d（不写 KV） | 活动照片代理 + cf.image 缩放，w∈[200,400,800,1200] 非法回退 800，fmt=jpeg/webp |
| GET | `/api/proof-files` | file_catalog_v1（惰性 60min） | 社员证明文件目录（title/owner/publishedAt/file）；出口仅放行「内容类型=社员证明」；资格判定在云函数侧 |
| GET | `/api/file?token=` | 边缘缓存 7d（不写 KV） | 社员证明附件**原样**代理（PDF 等任意类型，不经 cf.image） |
| POST | `/api/checkin` | 实时（写） | 签到提交：服务端按 uid 实时重查人（不信任前端）+ 异步双写（WPS 多维表 + 飞书机器人卡片），秒回 |
| POST | `/api/refresh` | 触发写 KV | 重建 4 快照（members/activity_records/activity_projects/file_catalog）；Bearer 鉴权 + 30s 冷却 |

### 管理 API（内部 `admin.html` 用，2026-09-06）

> 仅限核心成员使用：`https://nfc.raspjam.com/admin.html`。鉴权统一 `Authorization: Bearer <ADMIN_TOKEN>`；
> 所有响应 **no-store 且不带 CORS**（仅同源管理页可调，第三方网页无法读取）；查看接口返回**原文**（内部授权工具），大数组截前 30 条防整库倒出。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/kv/list` | KV 快照状态一览：条数 / 字节 / updatedAt / 健康（avatar 前缀仅计数） |
| GET | `/api/admin/kv?key=<key>&limit=<N>` | 单个 KV key 内容（原文直出，内部工具）；`limit` 1–20000（管理页默认带 20000=全量；接口不传仍为前 30 条样本）；`last_refresh_at` 返回可读时间（kind=ts）；图片类只回字节数 |
| POST | `/api/admin/refresh` | 与 `/api/refresh` 等价，鉴权同时接受 `ADMIN_TOKEN`（30s 冷却共用） |

> 安全备注：`members_full` 含「登录密码」等原始列——管理页可看原文（管理台为内部授权工具，访问受 `ADMIN_TOKEN` 保护）；如部署 CF Zero Trust Access，可把 `/admin.html` 与 `/api/admin/*` 再包一层登录墙（可选加固，见部署节）。

> 读接口缓存形态三种，按接口不同：
> - **KV 快照**（members/full/detail/member/activities 系列）：命中快照直接返回；KV 为空（首次/被清）自动实时拉飞书并回填 KV（冷启动自愈）
> - **Cache API 边缘缓存**：detail/activities/detail 300s、avatar 86400s、photo/file 604800s（key 按 token+参数隔离）
> - **CDN 缓存头**：members/members-full 响应 `Cache-Control: public, max-age=60`
> - **file_catalog_v1 惰性 TTL 60min**：目录快照 60 分钟内不重复拉飞书（cron/refresh 传 force 跳过）

## 缓存机制

### KV 存储（命名空间 SHUMEI_KV，绑定 `SHUMEI_KV`）

| key | 内容 | 刷新方式 |
|---|---|---|
| `members_full` | 社员全量快照 `{ updatedAt, items: [{recordId, fields}] }`（~1.4MB / 609 人） | cron + refresh + 读自愈 |
| `activity_records_v3` | 活动参与明细 join 项目/社员表，按 memberCode 展开成每人每条（~1138 条） | cron + refresh + 读自愈 |
| `activity_projects_v1` | 活动项目完整展示字段（含封面/相册附件 token，仅图片附件入快照；184 条） | cron + refresh + 读自愈 |
| `file_catalog_v1` | 文件资料表整表元数据（title/types/owner/publishedAt/files…；~120 条） | 惰性 60min + cron/refresh force |
| `avatar_img_<file_token>` | 头像图片字节（**永久**，0 过期；飞书删图后仍可访问） | /api/avatar 双层 miss 首访回写 |
| `last_refresh_at` | 最近一次 refresh 时间戳（毫秒），用于 30s 冷却（跨实例一致） | /api/refresh |

### 数据如何刷新

1. **Cron 兜底**：每小时第 30 分钟（`30 * * * *`）触发 `scheduled()`，四段独立重建：members_full → activity_records_v3 → activity_projects_v1 → file_catalog_v1(force)。单段失败不影响其余。
2. **飞书自动化触发（即时）**：飞书多维表配置自动化「记录变更 → 发送 HTTP 请求」，调 `POST /api/refresh`，秒级更新 KV。
3. **冷启动自愈**：任一读接口遇到 KV 为空/过期时，自动实时拉飞书并回填 KV 后返回。

### refresh 鉴权与冷却

`POST /api/refresh` 需要 `Authorization: Bearer <REFRESH_TOKEN>`（或 `?token=`）。带 **30 秒冷却**（KV `last_refresh_at`，跨实例一致），防止自动化频繁触发打爆飞书；无/错 token → 401，冷却内 → 429。

## 附件链路（头像 / 活动照片 / 证明文件）

飞书附件（「头像」「封面图片（1张）」「活动照片、活动成果和海报」「文件【首选】」）的 `url` 不带鉴权不可访问，`tmp_url` 需 tenant token 换取 `authcode` 临时直链（会过期）。Worker 统一用**白名单校验 + 取链兜底**：

```
白名单来源：成员快照（avatar）｜ 活动项目快照 activity_projects_v1（photo）｜ 文件目录 file_catalog_v1（file）
取链：附件.tmp_url → POST 换 authcode 直链 → 直取字节；失败兜底 附件.url + Bearer 头直取
```

| 端点 | 白名单 | L1 边缘缓存 | L2 KV | 缩放 | 备注 |
|---|---|---|---|---|---|
| `/api/avatar` | 成员快照「头像/个人照片」 | 1 天 | **永久** | 无（原图直出） | 飞书删图仍可访问；~97 张 ≈15MB |
| `/api/photo` | 活动项目封面/相册 token | **7 天** | ❌ 不写（738MB 不适合 KV） | **cf.image**（w∈[200,400,800,1200]，q80，fmt jpeg/webp，fit scale-down） | 成员头像 token 不能越权取活动照片（白名单隔离） |
| `/api/file` | file_catalog_v1「社员证明」附件 | **7 天** | ❌ 不写 | 无（原样透传，任意 Content-Type） | PDF 等任意类型 |

> **Cloudflare Image Resizing 已开启**（2026-09-03 线上实测）：`/api/photo` 依赖其缩放，免费额度每月 5,000 次唯一变换，当前用量（250 张 × 2 尺寸）远低于额度。`/api/avatar` 不缩放、原图直出。
> 缓存 key 按 token/参数隔离：`_cache/photo/<token>/<w>.<fmt>`，换图后新 token 自然产生新缓存条目。
> 附件对象格式：生产 REST `records` 附件带 `file_token`/`name`/`size`/`type`/`tmp_url`/`url`（详见 api-baseline 快照）。

## 活动数据与社员证明（小程序链路）

> 微信小程序与云函数代码不在本仓库。域名 `nfc.raspjam.com` 未 ICP 备案，小程序不能直连 Worker，一律经腾讯云函数中转。

- **member 云函数** → `/api/members/detail` 转发；头像经 `/api/avatar` 下载后 `cloud.uploadFile` 转存 `cloud://`
- **activities 云函数** → `/api/activities`（列表）、`/api/activities/detail`（详情）、`/api/photo?w=400` 缩略图转存云存储（按 token_w 去重、缓存 12h）
- **proofs 云函数** → `/api/proof-files`（目录缓存 12h）+ `/api/file` 下载；**资格判定在云函数本地**：`发布时间 ≥ 社员入社日期`（joinDate 随 `/api/members/detail` 下发，YYYY-MM-DD），Worker 侧不过滤
- 活动统计（参与人次/总时长/志愿时长）由 `activity_records_v3` 现场聚合；**任何接口不输出参与人名单**（isBlocked 隐私）

## 项目结构

```
├── index.html          # H5 签到页（样式 + 交互 + 逻辑；NFC/扫码/新卡登记）
├── admin.html          # 内部管理台（左栏选表 / 中间 AG Grid 铺满 / 右侧行详情抽屉 + 一键全量刷新，需 ADMIN_TOKEN）
├── worker.js           # Cloudflare Worker（14 条公开 API + 3 条管理 API + KV 缓存，见文件头注释）
├── wrangler.jsonc      # Wrangler 部署配置（KV 绑定 / Cron 30 * * * * / routes）
├── .wranglerignore     # 部署排除规则（*.md / *.csv / api-baseline 等）
├── start.sh            # 本地开发启动脚本（HTTPS 静态服务器）
├── AGENTS.md           # AI 协作者项目说明
├── DESIGN.md           # H5 页面设计规范
├── CHANGELOG.md        # 更新日志
├── docs/
│   ├── activity-api-plan.md      # 活动功能实现说明（含小程序/云函数链路）
│   ├── admin-console-plan.md     # 内部管理台方案（v3：KV 查看 + 一键刷新 + 字段开关规划）
│   ├── dataflow-audit-2026-09-06.html  # 数据流全景图 + 接口案例 + 文档核对（审查交付物）
├── vendor/ag-grid/      # AG Grid Community v36（管理台表格组件，同域自托管）
│   └── api-baseline/              # API 基线快照（含社员全量数据，git/wrangler 双忽略）
├── public/             # 旧静态数据（members.js 等，已废弃仅历史参考）
└── assets/             # 静态资源
```

## 本地运行

```bash
sh start.sh             # 启动 HTTPS 静态服务器（Web NFC 要求安全上下文）
```

本地开发时 API 不可用，自动降级到 `public/members.js`（如存在）。

## 部署

项目通过 **Git 推送到 GitHub 后由 Cloudflare Workers Builds 自动部署**。无需本地 wrangler。

### 部署前配置（Cloudflare Dashboard → Workers & Pages → shumeinfc-projects → 设置）

**环境变量 / 机密：**

| 环境变量 | 类型 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | Variable | 飞书应用 ID（已在 wrangler.jsonc 中配置） |
| `FEISHU_APP_SECRET` | **Secret** | 飞书应用密钥（需手动添加，防止泄露） |
| `FEISHU_APP_TOKEN` | Variable | 飞书多维表 App Token（wiki token 旧格式，REST 侧仍可用，勿更换） |
| `FEISHU_TABLE_ID` | Variable | 社员表 ID `tblepAz1PHnzwxA2` |
| `FEISHU_BOT` | **Secret** | 飞书机器人 Webhook（签到成功群通知） |
| `WPS_WEBHOOK` | **Secret** | WPS 多维表 Webhook（签到记录写入） |
| `REFRESH_TOKEN` | **Secret** | `/api/refresh` 鉴权 token（自己生成的长随机串） |
| `ADMIN_TOKEN` | **Secret** | `/api/admin/*` 管理端点鉴权 token（admin.html 登录口令；与 REFRESH_TOKEN 分开，权限隔离） |

**KV 命名空间：** 需在 Dashboard 创建（如 `shumei-members`），把 Namespace ID 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

**routes / Cron：** 已写在 `wrangler.jsonc`（自定义域名 `nfc.raspjam.com`、Cron `30 * * * *`），与远程一致。

> ⚠️ **注意**：`wrangler.jsonc` 里的 `routes` 必须保留 `nfc.raspjam.com` 自定义域名绑定，否则 deploy 会用本地配置覆盖远程、丢失域名。Cron 表达式分钟字段范围是 0-59（`*/60` 非法）。KV/Cron 结构改动会直接影响缓存同步。

### 飞书自动化配置（数据变更 → 即时刷新 KV）

在飞书多维表格 → **自动化** → 新建（社员表/活动表/文件表均可）：

1. **触发条件**：记录被创建时 / 记录字段更新时 / 记录被删除时
2. **动作**：发送 HTTP 请求
   - 方法：`POST`
   - URL：`https://nfc.raspjam.com/api/refresh`
   - 请求头：`Authorization: Bearer <REFRESH_TOKEN>`

保存后，表格里每新增/修改/删除记录，都会触发 Worker 重建 4 快照，网页与 App 秒级看到最新数据。

### 管理台（admin.html）安全说明与可选加固

- 访问入口：`https://nfc.raspjam.com/admin.html`，登录口令 = Secret `ADMIN_TOKEN`（管理员在 Cloudflare Dashboard 生成后**私发**给核心成员，不入仓库、不入聊天群）。
- 口令仅存浏览器 sessionStorage，关闭页面即失效；管理端点无 CORS + no-store，第三方网页无法跨域调用。
- 查看 KV 直接显示原文（含 members_full 的「登录密码/生日/年龄」等敏感列）——请仅在安全环境、本人使用时打开；口令勿外借。
- **可选加固（CF Zero Trust Access）**：Cloudflare Dashboard → Zero Trust → Access → Applications 新建应用，策略托管 `/admin.html` 与 `/api/admin/*`（include 规则用域名路径），成员用自己的邮箱/账号登录后再访问；适合想让"口令管理"交给 CF 时启用（免费版 50 用户内可用）。启用后管理员口令仍保留为兜底。
- 定期轮换：改口令 = Dashboard 里改一个 Secret 值 + 通知成员重新登录，随时可执行。

## 功能详解

### H5 查询链路

```
刷卡/扫码 → localStorage 单条登记缓存 → 24h 批量离线缓存 → /api/member（KV 快照 → 兜底实时飞书）
```

- 新卡登记后立即写入单条缓存；批量缓存可手动「刷新离线数据」按钮拉 `/api/members` 重建（24h TTL）
- `/api/member` 的实时兜底用于「刚登记、快照未刷新」的新卡场景，保证签到不失败

### 飞书通知卡片（签到）

签到成功后自动推送飞书群卡片（JSON 2.0），包含：
- 活动名称 + 时长（双列布局）
- 成员姓名、社员号、部门、班级
- 识别码 + 卡号（审计追溯）
- GPS 定位 + 高德地图链接（需授权）
- 聊天列表预览显示「姓名 · 活动名」
- 「查看签到记录」按钮（打开飞书多维表）

### 签到双写容错

`POST /api/checkin` 把飞书群通知与 WPS 写入放 `ctx.waitUntil` 后台执行：任一方失败只记日志，不影响签到结果与响应速度；WPS 侧写入 7 字段（cardUid/timestamp/userName/department/className/activity/duration），时间按东八区格式化。

### 多卡号

飞书多维表「社员卡号」字段支持 `;` 分隔多个卡号。查询时 Worker 先用 `CONTAINS` 粗筛，再在 JS 侧按分号做整卡号精确匹配，避免短卡号作为子串误命中其他成员的长卡号。

### 「禁止查询」隐私开关

勾选后仅 `/api/members/detail` 返回 `found:false`（且该响应不缓存，取消勾选立即恢复）；签到查人 / App 快照 / 头像代理均不受影响。活动接口不输出参与人名单，天然无泄露面。

### 识别码找回（`/api/members/find-code`）

微信小程序未绑定时用于找回本人的「社员识别码」。查询必须同时满足：姓名精确匹配 + 年级/有效班级/社团部门/社员编号中至少两项精确匹配；有效班级直接使用飞书公式列「班级」（分班后为空时取分班前，皆空为「未知」并视为无班级），姓名单独查询不会返回候选。命中「禁止查询」的社员一律视为未找到。唯一命中才回 `member.code` 与 `member.seq`（社员编号）；多命中只回脱敏候选人列表（不含识别码），由用户补充社员编号或班级等更多信息后重新查询。响应 `Cache-Control: no-store`，避免个人识别码被边缘缓存扩散。

## 版本历史

| 版本 | 日期 | 里程碑 |
|---|---|---|
| **1.17.0** | 2026-09-09 | 新增 `/api/members/find-code` 识别码找回：姓名 + 至少两项信息强匹配，禁查过滤，唯一命中才回社员识别码（no-store） |
| **1.16.0** | 2026-09-07 | 管理台改「左选表 · 中铺表 · 右看行」三栏：左栏切 4 张数据表，中间表格铺满，点行从右滑出该条完整字段 |
| **1.13.0** | 2026-09-06 | 管理台表格升级 AG Grid（排序/列过滤/分页/CSV 导出，vendor/ 同域自托管）；`/api/admin/kv` 支持 `limit` 加载全部；修复大 key 表格不可用 |
| **1.12.0** | 2026-09-06 | 内部管理台：`admin.html` + `/api/admin/kv/list`、`/api/admin/kv?key=`、`/api/admin/refresh`；独立 Secret `ADMIN_TOKEN`，管理端点 no-store 无 CORS |
| **1.11.0** | 2026-09-06 | 社员证明：`/api/proof-files` + `/api/file`（白名单 PDF 代理，边缘 7d）；文件目录快照 `file_catalog_v1`（惰性 60min）纳入 cron/refresh；detail 新增 `joinDate`；目录接口新增 owner 字段 |
| **1.10.0** | 2026-09-03 | 活动页 API：`/api/activities` + `/api/activities/detail`（无参与人名单）+ `/api/photo`（cf.image 缩放）；新增 `activity_projects_v1` 完整快照；头像获取不再回退「个人照片」 |
| **1.9.0** | 2026-08-26 | 「禁止查询」复选框：勾选后 `/api/members/detail` 返回 `found:false`（签到查人 / App 快照 / 头像代理不受影响） |
| **1.8.1** | 2026-08-17 | detail 有 `file_token` 的成员跳过飞书 authcode 换取（输出 `avatarProxy`、`avatar` 置空）：冷访问 TTFB ~2s → ~0.4s |
| **1.8.0** | 2026-08-17 | 头像代理 `/api/avatar`：L1 边缘缓存 + L2 KV 永久（飞书删图仍可访问）；detail 新增可选字段 `avatarProxy`（原 `avatar` 不变） |
| **1.7.0** | 2026-08-13 | 社员数据 KV 缓存：读接口 KV 优先、Cron 每小时兜底、`/api/refresh` 触发刷新、`/api/members/detail` 单人脱敏档案 |
| **1.6.0** | 2026-08-07 | `/api/member` 补齐 `position` 与 `joinYear`，卡号整卡精确匹配 |
| **1.5.0** | 2026-08-05 | 新增 `/api/members/full` 全量快照（App 本地缓存） |
| **1.4.0** | 2026-08-05 | 签到提交迁移到 Worker：`POST /api/checkin`，统一写 WPS + 发飞书通知 |
| **1.3.0** | 2026-08-04 | 升级卡片到 JSON 2.0，新增地理位置、聊天列表摘要、column_set 双列布局 |
| **1.1.1** | 2026-08-04 | 支持多卡号（分号分隔），Worker 改用 CONTAINS 匹配 |
| **1.1.0** | 2026-08-04 | 重大重构：数据源从本地 members.js 切换为飞书多维表 API，新增 Worker 后端、离线批量缓存 |
| **1.0.7** | 2026-07-24 | 重构签到页面 UI，适配 iOS 安全规范 |
| **1.0.0** | 2026-07-22 | 项目初始化：NFC 签到、扫码签到、本地缓存、飞书/WPS 推送 |

## 兼容性

| 平台 | NFC | 扫码 |
|---|---|---|
| Android Chrome 89+ | ✓ | ✓ |
| iOS Safari | ✗ | ✓（需授权摄像头） |
| 飞书内置浏览器 | ✗ | ✓ |

## 维护

- **接口文档三件套必须同步**：改动 Worker 后，同步更新本 README（接口表/KV 表/版本表）、`CHANGELOG.md`、`worker.js` 文件头注释（保持头注释 = 路由全集）；改 H5 页面后同步更新 `index.html` 中 `APP_VERSION`/`APP_UPDATED_AT` 与 DESIGN.md。
- 改动 Worker 后推 GitHub 即可自动部署；**注意不要动 `wrangler.jsonc` 里的 routes / KV 绑定 / Cron**，否则可能影响自定义域名或缓存同步。
- 若改了缓存数据结构（如 `members_full` 的 schema），记得把 `getSnapshot` 读取的 key 或格式一并调整，避免旧缓存数据不兼容；活动/文件快照同理（key 带版本号如 `_v3`/`_v1` 便于重建）。
- `docs/api-baseline/` 含社员全量原始数据（含登录密码等敏感列），已被 .gitignore 与 .wranglerignore 双排除，禁止推送与部署；新接口上线前后可用 `docs/api-baseline/00-grab.sh` 抓取基线做回归对比。
- 排查问题：Cloudflare Dashboard → Workers → shumeinfc-projects → **实时日志**，可看到 `/api/refresh` 的 401 / 200 / 429 记录与各接口错误。
