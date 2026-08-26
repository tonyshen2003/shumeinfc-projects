# 树莓社活动签到系统（shumeinfc-projects）

树莓社（苏州中学）的 NFC 刷卡 + 二维码扫码签到 H5 应用 + 社员数据 API，部署于 Cloudflare Workers 边缘网络。
核心是**对飞书多维表（Bitable）的安全代理**：凭据只在 Worker 端，并对社员数据做 **KV 缓存**，避免频繁、慢速地实时访问飞书。

## 架构

```
┌─ 浏览器 H5 (index.html) ──────────────────────────┐
│  localStorage 缓存层（毫秒级）：单条登记缓存 + 24h 批量离线缓存 │
└──────────────┬──────────────────────────────────┘
               ▼
┌─ Cloudflare Worker (worker.js) ────────────────────────────┐
│  读接口 → KV 缓存（秒回，几乎不碰飞书）                       │
│    GET /api/members/full     全量原始记录（App 快照用）       │
│    GET /api/members/detail   单人脱敏档案（网页用）           │
│    GET /api/members          卡号/识别码/姓名映射            │
│    GET /api/member           uid/q 查人（KV 优先+实时兜底）   │
│    GET /api/avatar           头像代理直链（边缘缓存+KV 永久）  │
│  写/实时接口 → 直接飞书                                      │
│    POST /api/checkin         签到：写 WPS + 发飞书通知       │
│  触发刷新接口                                                │
│    POST /api/refresh         拉全量写 KV（飞书自动化调用）     │
└──────────────┬──────────────────────────────────────────┘
               │
        KV（SHUMEI_KV）
          ├─ members_full     社员全量快照
          ├─ avatar_img_<token> 头像图片字节（永久，飞书删图仍可访问）
          └─ last_refresh_at  refresh 冷却时间戳
               ▲
               │ Cron（每小时第 30 分钟）自动拉全量写 KV（兜底）
               │ 飞书自动化「记录变更 → HTTP」触发 refresh（即时）
               │
┌─ 飞书多维表（Bitable）── 唯一数据源 ─┐
└─────────────────────────────────┘
```

## 功能

- **NFC 刷卡签到** — Android Chrome 89+，读取 NFC 卡片 UID 自动匹配社员
- **二维码扫码签到** — 扫描社员识别码（如 `SM201809A00100201`）
- **离线可用** — 首次访问自动缓存全量成员数据，后续无网络也能识别已入库成员
- **新卡登记** — 未匹配卡片弹窗输入姓名，关联后自动缓存
- **飞书通知** — 签到成功自动推送飞书机器人卡片消息
- **WPS 同步** — 签到记录同步写入 WPS 多维表
- **社员隐私开关** — 飞书表勾选「禁止查询」复选框，公开档案页即查不到该成员（签到/App 快照不受影响）
- **社员数据 KV 缓存** — 读接口秒回，飞书只被 Cron / 手动触发访问，防慢速与配额

## 接口清单

| 方法 | 路径 | 数据源 | 说明 |
|---|---|---|---|
| GET | `/api/members/full` | KV 缓存 | 全量原始记录（含 `record_id`），供 App 本地快照缓存 |
| GET | `/api/members/detail?code=<识别码>` | KV 缓存 | 单人**脱敏**完整档案（不含登录密码/QQ/电话/身份证/卡号等），供网页；勾选「禁止查询」的成员返回 `found:false` |
| GET | `/api/members` | KV 缓存 | 卡号/识别码/姓名 → 成员信息映射 |
| GET | `/api/member?uid=<卡号>` | KV 优先+实时兜底 | 按卡号/识别码/认读码查人（签到用） |
| GET | `/api/member?q=<姓名>` | KV 优先+实时兜底 | 姓名/别名/编号/识别码/序号搜索 |
| GET | `/api/avatar?token=<file_token>` | 边缘缓存+KV 永久 | 头像图片代理直链（见「图片链路」） |
| POST | `/api/checkin` | 实时（写） | 签到提交：服务端重新查人 + 写 WPS + 发飞书通知 |
| POST | `/api/refresh` | 触发写 KV | 拉飞书全量写 KV，供飞书自动化调用（需鉴权） |

> 读接口（前 5 个）全部 **KV/边缘缓存优先**：命中快照直接返回；KV 为空（首次/被清）时自动实时拉飞书并回填 KV。
> `/api/member` 的实时兜底用于「刚登记、快照未刷新」的新卡场景，保证签到不失败。
>
> **`/api/members/detail` 新增可选字段 `avatarProxy`**（头像代理直链 URL）：既有消费方读原 `avatar` 字段行为不变；希望图片走 CF 缓存/永久可用的下游可改读 `avatarProxy`（页面模板已优先使用，`avatar` 兜底）。
>
> **性能说明**：有附件（`file_token`）的成员，detail 直接输出 `avatarProxy` 并**跳过飞书换取**（`avatar` 置空），冷访问不再有 1~2s 换取耗时；无附件的历史成员才走旧换取兜底。

## 缓存机制

### 存储

KV 命名空间 `SHUMEI_KV`（绑定名 `SHUMEI_KV`），两个 key：

| key | 内容 |
|---|---|
| `members_full` | 社员全量快照：`{ updatedAt, items: [{ recordId, fields }] }` |
| `avatar_img_<file_token>` | 头像图片字节（**永久**，0 过期；飞书删图后仍可访问） |
| `last_refresh_at` | 最近一次 refresh 的时间戳（毫秒），用于冷却 |

### 数据如何刷新

1. **Cron 兜底**：每小时第 30 分钟（`30 * * * *`）拉一次飞书全量写 KV。保证即使没人触发，数据也不陈旧超过 1 小时。
2. **飞书自动化触发（即时）**：在飞书多维表格里配置自动化「记录变更 → 发送 HTTP 请求」，数据一改就调 `POST /api/refresh`，秒级更新 KV。
3. **冷启动自愈**：任一读接口遇到 KV 为空时，自动实时拉飞书并回填 KV。

### refresh 鉴权与冷却

`POST /api/refresh` 需要 `Authorization: Bearer <REFRESH_TOKEN>`（或 `?token=`）。带 **30 秒冷却**（用 KV 存时间戳，跨实例一致），防止自动化频繁触发打爆飞书。

## 图片链路（头像代理）

飞书附件（「头像」/「个人照片」）的 `url` 不带鉴权不可访问（400），`tmp_url` 需 tenant token 换取 `authcode` 临时直链（会过期）。为让图片**稳定、可永久访问**，Worker 提供代理端点：

```
<img src="https://nfc.raspjam.com/api/avatar?token=<file_token>">
        │
        ▼
/api/avatar（token 白名单校验：必须存在于成员快照附件中）
  ├─ L1 边缘缓存命中（Cache API，TTL 1 天）→ 直接返回
  ├─ L2 KV 命中（avatar_img_<token>，永久）→ 直接返回
  └─ 双层 miss → 换 authcode → 拉飞书字节 → 回写 L1+L2（永久）→ 返回
```

| 场景 | 行为 |
|---|---|
| 首次访问某头像 | 约 1~2s（换 authcode + 拉字节 + 写双层缓存） |
| 再次访问 | CF 边缘缓存直出（约 0.1s，不依赖飞书） |
| 飞书**换**图 | 新 file_token → 新缓存条目 → ≤5 分钟生效（detail 缓存 TTL） |
| 飞书**删**图 | KV **永久**兜底，旧图照常可访问（隐私权衡：删图不会全网消失） |
| 双层 miss 且飞书已删 | 404 → 页面回退首字占位（不裂图） |

- 存储量：~97 张 × 60~315KB ≈ 15MB（KV 免费额度 1GB）；每 token 首次写入 1 次
- 端点带 `Access-Control-Allow-Origin: *`（供本地预览等浏览器直连）
- **不启用 Cloudflare Image Resizing**（付费功能）：原图直出，不压缩

## 项目结构

```
├── index.html          # 主页面（样式 + 交互 + 逻辑）
├── worker.js           # Cloudflare Worker（API 代理 + KV 缓存 + 静态资源）
├── wrangler.jsonc      # Wrangler 部署配置（KV 绑定 / Cron / routes）
├── .wranglerignore     # 部署排除规则
├── start.sh            # 本地开发启动脚本
├── public/
│   ├── members.js      # 社员数据（已废弃，仅保留作为历史参考）
│   ├── members.csv     # 社员登记表源数据
│   └── card-members.csv # 卡号映射源数据
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
| `FEISHU_APP_TOKEN` | Variable | 飞书多维表 App Token |
| `FEISHU_TABLE_ID` | Variable | 飞书多维表 ID |
| `FEISHU_BOT` | **Secret** | 飞书机器人 Webhook（签到成功群通知） |
| `WPS_WEBHOOK` | **Secret** | WPS 多维表 Webhook（签到记录写入） |
| `REFRESH_TOKEN` | **Secret** | `/api/refresh` 鉴权 token（自己生成的长随机串） |

**KV 命名空间：** 需在 Dashboard 创建（如 `shumei-members`），把 Namespace ID 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。

**routes / Cron：** 已写在 `wrangler.jsonc`（自定义域名 `nfc.raspjam.com`、Cron `30 * * * *`），与远程一致。

> ⚠️ **注意**：`wrangler.jsonc` 里的 `routes` 必须保留 `nfc.raspjam.com` 自定义域名绑定，否则 deploy 会用本地配置覆盖远程、丢失域名。Cron 表达式分钟字段范围是 0-59（`*/60` 非法）。

### 飞书自动化配置（数据变更 → 即时刷新 KV）

在飞书多维表格 → **自动化** → 新建：

1. **触发条件**：记录被创建时 / 记录字段更新时 / 记录被删除时
2. **动作**：发送 HTTP 请求
   - 方法：`POST`
   - URL：`https://nfc.raspjam.com/api/refresh`
   - 请求头：`Authorization: Bearer <REFRESH_TOKEN>`

保存后，表格里每新增/修改/删除一条社员记录，都会触发 Worker 刷新 KV，网页与 App 秒级看到最新数据。

## 功能详解

### 查询链路

```
刷卡/扫码 → localStorage 单条缓存 → 离线批量缓存 → Worker（KV 缓存 → 兜底飞书）
```

### 飞书通知卡片

签到成功后自动推送飞书群卡片，包含：
- 活动名称 + 时长（双列布局）
- 成员姓名、社员号、部门、班级
- 识别码 + 卡号（审计追溯）
- GPS 定位 + 高德地图链接（需授权）
- 聊天列表预览显示「姓名 · 活动名」

### 多卡号

飞书多维表「社员卡号」字段支持 `;` 分隔多个卡号。查询时 Worker 先用 `CONTAINS` 粗筛，再在 JS 侧按分号做整卡号精确匹配，避免短卡号作为子串误命中其他成员的长卡号。

## 版本历史

| 版本 | 日期 | 里程碑 |
|---|---|---|
| **1.9.0** | 2026-08-26 | 「禁止查询」复选框：勾选后 `/api/members/detail` 返回 `found:false`（签到查人 / App 快照 / 头像代理不受影响） |
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

- 修改功能后请同步更新 `index.html` 中的 `APP_VERSION` 和 `APP_UPDATED_AT`。
- 改动 Worker 后推 GitHub 即可自动部署；**注意不要动 `wrangler.jsonc` 里的 routes / KV 绑定 / Cron**，否则可能影响自定义域名或缓存同步。
- 若改了缓存数据结构（如 `members_full` 的 schema），记得把 `getSnapshot` 读取的 key 或格式一并调整，避免旧缓存数据不兼容。
- 排查问题：Cloudflare Dashboard → Workers → shumeinfc-projects → **实时日志**，可看到 `/api/refresh` 的 401 / 200 / 429 记录。
