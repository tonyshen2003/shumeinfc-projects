# 树莓社活动签到系统

树莓社（苏州中学）的 NFC 刷卡 + 二维码扫码签到 H5 应用，部署于 Cloudflare Workers 边缘网络。

## 架构

```
浏览器 (index.html)
  ├─ localStorage 缓存层（毫秒级）
  │    ├─ 单条登记缓存 (shumei_card_members)
  │    └─ 批量离线缓存 (shumei_member_cache) · 24h TTL
  │
  └─ Cloudflare Worker (worker.js)
       ├─ GET /api/member?uid=X  → 飞书多维表实时查询
       ├─ GET /api/member?q=X    → 姓名/编号模糊搜索
       ├─ GET /api/members       → 全量成员数据（供离线缓存）
       ├─ GET /api/members/full  → 全量原始记录（含 record_id，供 App 快照）
       └─ POST /api/checkin      → 签到提交：写 WPS + 发飞书通知
```

数据源为飞书多维表（Bitable），通过 Worker 安全代理，凭据存储在 Cloudflare 环境变量中，不暴露到前端。

## 功能

- **NFC 刷卡签到** — Android Chrome 89+，读取 NFC 卡片 UID 自动匹配社员
- **二维码扫码签到** — 扫描社员识别码（如 `SM201809A00100201`）
- **离线可用** — 首次访问自动缓存全量成员数据，后续无网络也能识别已入库成员
- **新卡登记** — 未匹配卡片弹窗输入姓名，关联后自动缓存
- **飞书通知** — 签到成功自动推送飞书机器人卡片消息
- **WPS 同步** — 签到记录同步写入 WPS 多维表

## 项目结构

```
├── index.html          # 主页面（样式 + 交互 + 逻辑）
├── worker.js           # Cloudflare Worker（API 代理 + 静态资源）
├── wrangler.jsonc      # Wrangler 部署配置
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

项目通过 Git 推送到 GitHub 后由 Cloudflare Workers Builds 自动部署。

部署前需在 Cloudflare Dashboard → Workers & Pages → shumeinfc-projects → Settings → Variables and Secrets 配置：

| 环境变量 | 类型 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | Variable | 飞书应用 ID（已在 wrangler.jsonc 中配置） |
| `FEISHU_APP_SECRET` | **Secret** | 飞书应用密钥（需手动添加，防止泄露） |
| `FEISHU_APP_TOKEN` | Variable | 飞书多维表 App Token |
| `FEISHU_TABLE_ID` | Variable | 飞书多维表 ID |
| `FEISHU_BOT` | **Secret** | 飞书机器人 Webhook（签到成功群通知） |
| `WPS_WEBHOOK` | **Secret** | WPS 多维表 Webhook（签到记录写入） |

## 功能详解

### 查询链路

```
刷卡/扫码 → localStorage 单条缓存 → 离线批量缓存 → Worker API → 飞书多维表
```

### 飞书通知卡片

签到成功后自动推送飞书群卡片，包含：
- 活动名称 + 时长（双列布局）
- 成员姓名、社员号、部门、班级
- 识别码 + 卡号（审计追溯）
- GPS 定位 + 高德地图链接（需授权）
- 聊天列表预览显示「姓名 · 活动名」

### 多卡号

飞书多维表「社员卡号」字段支持 `;` 分隔多个卡号，Worker 使用 `CONTAINS` 匹配。

## 版本历史

| 版本 | 日期 | 里程碑 |
|---|---|---|
| **1.3.0** | 2026-08-04 | 升级卡片到 JSON 2.0，新增地理位置、聊天列表摘要、column_set 双列布局 |
| **1.1.1** | 2026-08-04 | 支持多卡号（分号分隔），Worker 改用 CONTAINS 匹配 |
| **1.1.0** | 2026-08-04 | 重大重构：数据源从本地 members.js 切换为飞书多维表 API，新增 Worker 后端、离线批量缓存 |
| **1.0.7** | 2026-07-24 | 重构签到页面 UI，适配 iOS 安全规范 |
| **1.0.5** | 2026-07-23 | 优化摄像头对焦逻辑，添加降级方案 |
| **1.0.2** | 2026-07-22 | 更新成员数据与脚本版本 |
| **1.0.1** | 2026-07-23 | 新增版本号显示、README 和 CHANGELOG |
| **1.0.0** | 2026-07-22 | 项目初始化：NFC 签到、扫码签到、本地缓存、飞书/WPS 推送 |

## 多卡号支持

飞书多维表的「社员卡号」字段支持用分号分隔多个卡号：

```
0430ACC3100389;04932421CE2A81;21D6E774
```

查询时 Worker 使用 `CONTAINS` 子串匹配，任意一张卡均能命中。

## 兼容性

| 平台 | NFC | 扫码 |
|---|---|---|
| Android Chrome 89+ | ✓ | ✓ |
| iOS Safari | ✗ | ✓（需授权摄像头） |
| 飞书内置浏览器 | ✗ | ✓ |

## 维护

修改功能后请同步更新 `index.html` 中的 `APP_VERSION` 和 `APP_UPDATED_AT`。
