# 更新日志

## 1.18.0 - 2026-09-10
- 新增「位置雷达」后端（Cloudflare D1）：
  - `POST /api/presence/heartbeat`：在线位置心跳，App 每 60s 上报一次，同时携带社员编号与 GCJ-02 / WGS-84 双坐标
  - `GET /api/presence/nearby?self=`：当前在线社员（不含本人），距离/方位由客户端本地计算
  - `POST /api/presence/offline`：退出雷达 / App 进后台立即下线
  - 鉴权使用独立 Secret `PRESENCE_APP_TOKEN`；只存“当前在线”一条，不保存历史轨迹，超过 3 分钟视为离线
- 新增管理台「位置地图」：完整在线地图（所有在线社员），复用现有 `ADMIN_TOKEN` 登录与 no-store 机制
  - `GET /api/admin/presence/map`：全量在线名单（含双坐标）
  - `POST /api/admin/presence/init`：幂等初始化 D1 presence 表
  - 地图组件 Leaflet 1.9.4 同域自托管（`vendor/leaflet/`）；默认 OSM/WGS-84 底图，可替换国内底图
- 新增 D1 绑定 `PRESENCE_DB`（`wrangler.jsonc` 中 database_id 为占位值，首次部署前需替换）
- iOS 端配套：新增 `PresenceService` / `MemberRadarView`，入口在「我的树莓 → 寻找身边社员」
  - 进入页面才上报并互相可见；退出 / 进后台即下线；显示精确距离、方位、届别、部门，不显示姓名

## 1.17.0 - 2026-09-09
- 新增 `GET /api/members/find-code`：社员识别码找回（微信小程序未绑定时用）
  - 强匹配规则：姓名必填，且 年级/有效班级/部门/社员编号 中至少提供两项，任一字段精确匹配
  - 有效班级直接使用飞书公式列「班级」（分班后为空取分班前），「未知」视为无班级
  - 勾选「禁止查询」的社员一律返回 `found:false`，与 `/api/members/detail` 一致
  - 唯一命中才返回「社员识别码」与社员编号，多命中只回脱敏候选（姓名/年级/班级/部门），不下发识别码
  - 数据源 = `members_full` KV 快照；响应 `no-store`，不落边缘缓存

## 1.16.1 - 2026-09-07
- 表格里的日期不再是一串数字（纯前端渲染层处理，数据不动）：
  - 识别规则 = **字段语义 + 数值量级**双重判定：毫秒时间戳（1e12~4e12）直接转；秒级时间戳与 Excel 日期序列需字段名命中日期关键字才转，避免把「参与活动时长 / 次数 / 志愿服务时长」这类普通数字误伤
  - 显示：`修改时间 / 录入时间` → `2026-09-04 17:48`；`入社日期 / 生日` → `2018-09-12`（北京 0 点整的按纯日期，不带 00:00）；`倒数日`（Excel 序列 46282）→ `2026-09-17`
  - 统一按**北京时间（UTC+8）**换算，与后端 `fmtBeijing` 口径一致
  - 日期列的排序 / 列过滤 / CSV 导出同样用可读串（`YYYY-MM-DD HH:mm` 字典序即时间序）；悬停提示附原始值
  - 行详情抽屉：可读日期 + 灰色原始值并列显示

## 1.16.0 - 2026-09-07
- 管理台布局重构为「**左选表 · 中铺表 · 右看行**」三栏式：
  - **左侧栏**承担选表：4 张数据表（社员 / 活动参与 / 活动项目 / 文件目录）以列表呈现，含中文名、KV key、条数徽标、新鲜度圆点（绿=70 分钟内 / 黄=陈旧 / 红=缺失）；首次进入自动选中第一张表
  - **中间主区**整块留给表格：标题+元信息（key / 体积 / 更新时间 / 条数）置顶，AG Grid 铺满剩余高度（不再页面滚动）；工具条集成全表搜索、表格⇄JSON、导出 CSV、重载
  - **右侧抽屉只用于看行**：点任意一行 → 从右滑出该条记录的完整字段（字段 / JSON 双视图、上一条下一条、复制 JSON、Esc 关闭）
  - 顶栏新增「最近刷新 · X 分钟前」状态胶囊；侧栏脚注显示最近全量刷新时间、头像缓存张数、数据源
- 取消 KV 卡片网格总览（其信息已并入左栏列表与脚注），`last_refresh_at` / 头像缓存不再作为「表」出现在选择列表
- 一键刷新完成后自动刷新左栏条数 + 当前表内容

## 1.15.0 - 2026-09-07
- 管理页打开快照 key 即**直接加载全量数据**（`limit=20000`），移除「先 30 条样本再点加载全部」流程；JSON 视图同显全量
- `last_refresh_at` 友好展示：总览卡片显示相对时间（如「5 分钟前」）+ 完整时间；详情抽屉显示北京时区可读时间（后端 `kind=ts`，含原始毫秒值）
- 后端优化：数组快照不再重复生成文本 sample（响应体减半）；`/api/admin/kv/list` 对时间戳 key 解析出 updatedAt
- 接口层不传 `limit` 仍为前 30 条样本，向后兼容

## 1.14.0 - 2026-09-06
- 管理台 UI 重构：由单列直排列表改为 **Semi Design 风格现代中后台布局**（抖音设计系统官方默认主题 token 取值）
  - 顶栏 + 左侧导航（KV 快照 / 一键全量刷新 / 数据开关[规划中]）+ 独立内容视图
  - KV 总览改为**卡片网格 Dashboard**（大数字条数 / 体积 / 更新时间 / 健康徽标），悬停高亮进入
  - 详情由「页面下推」改为**右侧滑出抽屉**（表格⇄JSON 切换、AG Grid、单条详情、加载全部、CSV 导出均在抽屉内），Esc / 遮罩点击关闭
  - 视觉：字节主色 `#0064FA`（semi-blue-5）、圆角 12/6/3、`rgba(28,31,35,.08)` 细边框、克制的层级阴影、线性 SVG 图标、右上角通知卡片；响应式（≤900px 导航转横向）
- 功能与数据链路零改动（接口/鉴权/冷却/limit 不变）

## 1.13.0 - 2026-09-06
- 管理台表格升级：引入 **AG Grid Community v36**（`vendor/ag-grid/` 同域自托管，MIT 开源组件，非自研）
  - 列排序、每列浮动过滤、底部分页（50/100/200/500）、CSV 导出、行点击查看单条详情
  - 主键列与 # 列冻结在左，悬停显示完整值，空值灰点占位，飞书蓝强调色浅色主题
- `GET /api/admin/kv` 新增 `limit` 参数（1–20000，默认 30）：管理页「加载全部」可一次拉取整表浏览
- 修复：members_full 等大 key 表格不可用——文本预览截断不再连带清空表格结构化数据（30 条 ≈100KB，此前超过 60K 字符上限即回退文本）
- 构建修复：`const j` 误赋值导致 CF esbuild 构建失败（c700d7f），本地起用 esbuild 语义构建校验

## 1.12.0 - 2026-09-06
- 新增内部管理台 `admin.html`（`https://nfc.raspjam.com/admin.html`）+ 管理 API：
  - `GET /api/admin/kv/list`：KV 快照状态一览（条数/体积/updatedAt/健康）
  - `GET /api/admin/kv?key=`：单 key 内容原文直出（内部授权工具；大数组截前 30 条防整库倒出；图片类仅回字节数）
  - `POST /api/admin/refresh`：一键全量刷新（与 /api/refresh 等价）
- 新增 Secret `ADMIN_TOKEN`（独立于 REFRESH_TOKEN）；`/api/refresh` 鉴权兼容两种口令
- 管理端点安全设计：全部 Bearer 鉴权、响应 no-store、不加 CORS（仅同源管理页可调）；admin.html 口令仅存 sessionStorage

## 1.11.0 - 2026-09-06
- 新增 `GET /api/proof-files`：社员证明文件目录（内容类型=社员证明 白名单出口；含 title/owner/publishedAt/file）
- 新增 `GET /api/file?token=`：社员证明附件原样代理（PDF 等任意类型；L1 边缘缓存 7 天，不写 KV）
- 新增文件资料表目录快照 `file_catalog_v1`（整表元数据，惰性 60min TTL；纳入 cron 与 POST /api/refresh force 重建）
- `/api/members/detail` 新增 `joinDate`（YYYY-MM-DD，入社日期，北京时区）—— 资格判定（发布时间 >= 入社日期）在微信云函数 proofs 本地比较
- 目录与 proof-files 接口新增 `owner`（资料负责人）字段
- 出入口白名单设计：缓存「宽」（整表进 KV 供未来开放新类型）、出口「窄」（仅社员证明可下载）

## 1.10.0 - 2026-09-03
- 新增活动页 API：`GET /api/activities`（年份/类型/关键词筛选 + 分页 + facets）、`GET /api/activities/detail?id=`（只出统计数字与照片，**不出参与人名单**）、`GET /api/photo`（活动照片代理 + cf.image 缩放，w∈[200,400,800,1200]，L1 边缘缓存 7 天，不写 KV）
- 新增 KV key `activity_projects_v1`：活动项目完整快照（含封面/相册附件 token，仅保留图片附件——图片扩展名白名单过滤，剔除混入的文档/PPT/音视频）
- 统计口径复用现有 `activity_records_v3` 现场聚合（未新增 activity_detail_v1）；`/api/avatar` 保持原逻辑不变
- 头像取图逻辑调整：detail/avatar 仅取「头像」字段，不再回退「个人照片」（commit 95af447）
- 项目快照纳入 cron 与 refresh 同步刷新

## 1.9.0 - 2026-08-26
- 新增「禁止查询」访问控制：飞书多维表勾选该复选框的成员，`/api/members/detail` 返回 `found:false`（档案页显示"识别码未找到"）
- 仅拦截 detail 档案查询；签到查人（`/api/member`）、App 快照（`/api/members/full`）、头像代理（`/api/avatar`）不受影响
- 勾选前已缓存的档案条目最长 5 分钟内自然过期（边缘缓存 TTL）；取消勾选后下次 KV 刷新即恢复可查
- 飞书侧需新增复选框字段，列名必须为「禁止查询」（与代码字段名精确一致）

## 1.8.1 - 2026-08-17
- detail 有 `file_token` 的成员跳过飞书 authcode 换取（输出 `avatarProxy`、`avatar` 置空）：冷访问 TTFB ~2s → ~0.4s
- 无附件的历史成员保留旧换取兜底，行为不变

## 1.8.0 - 2026-08-17
- 新增 `GET /api/avatar?token=<file_token>` 头像代理：L1 边缘缓存（Cache API，1 天）+ L2 KV 永久（`avatar_img_<token>`，0 过期）
- 飞书删图后旧头像仍可通过代理永久访问；换图 ≤5 分钟生效（detail 缓存 TTL）
- `/api/members/detail` 新增可选字段 `avatarProxy`（代理直链），原 `avatar` 字段保持不变，既有消费方零影响
- 代理端点带 `Access-Control-Allow-Origin: *`；token 白名单校验（必须存在于成员快照附件）
- 不启用付费的 Cloudflare Image Resizing：原图直出

## 1.6.0 - 2026-08-07
- `GET /api/member` 返回字段补齐 `position`（社团职务）与 `joinYear`（入社年份），与 DeepMei App 快照字段对齐
- 卡号匹配改为「CONTAINS 粗筛 + JS 侧整卡号精确匹配」，避免短卡号子串误命中其他成员的长卡号

## 1.5.0 - 2026-08-05
- 新增 `GET /api/members/full`：分页返回全量成员原始记录（含 record_id），供 DeepMei App 本地快照缓存

## 1.4.0 - 2026-08-05
- 签到提交迁移到 Worker：新增 `POST /api/checkin`，统一负责写 WPS 多维表 + 发飞书机器人通知
- 前端不再持有 WPS / 飞书机器人 webhook 地址，改为 Cloudflare 环境变量 `WPS_WEBHOOK`、`FEISHU_BOT`
- 网页 NFC / 扫码 / 新卡登记 / 离线缓存与页面显示行为不变

## 1.3.0 - 2026-08-04
- 飞书通知卡片升级为 JSON 2.0 格式
- 新增地理位置（浏览器 GPS 授权后显示坐标 + 高德地图链接）
- 活动/时长使用 column_set 双列布局
- 添加 `config.summary`，聊天列表预览显示「姓名 · 活动名」
- 按钮改为 2.0 独立 button + behaviors
- 时长未填时默认显示「0小时」
- 修复 `divider`/`action` 在 Bot Webhook 2.0 下不兼容的问题

## 1.1.2 - 2026-08-04
- 修复登记确认时 `pendingMemberExtra` 被 `hideRegisterModal` 提前清空
- 统一 displayUid 逻辑，`processCardWithMember` 从离线缓存获取识别码

## 1.1.1 - 2026-08-04
- 支持多卡号：飞书社员卡号字段可使用 `;` 分隔多个卡号
- Worker 单条查询改用 `CONTAINS` 子串匹配
- 离线缓存构建时自动拆分多卡号，每张卡独立索引
- 重设缓存刷新按钮，符合飞书移动端设计规范
- 统一 displayUid 显示逻辑，所有路径优先显示识别码

## 1.1.0 - 2026-08-04
- **重大重构**：数据源从本地 `public/members.js` 切换为飞书多维表 API
- 新增 Cloudflare Worker (`worker.js`) 作为 API 安全代理层
- 新增离线批量缓存机制：首次访问从 `/api/members` 拉取全量数据
- 查询链路：localStorage → 离线缓存 → 在线 API 三级降级
- 扫码签到同时支持 NFC 卡号和社员识别码
- 新增 `.wranglerignore`，排除敏感文件上传
- 移除本地 `members.js` 依赖（112KB 静态数据）

## 1.0.7 - 2026-07-24
- 重构签到页面 UI 与功能
- 适配 iOS 安全规范（viewport-fit、safe-area-inset）
- 新增卡号显示逻辑

## 1.0.5 - 2026-07-23
- 优化摄像头对焦检测与容错逻辑
- 新增焦点扫描降级方案

## 1.0.4 - 2026-07-23
- 优化二维码摄像头对焦逻辑

## 1.0.2 - 2026-07-22
- 更新成员数据与脚本版本

## 1.0.1 - 2026-07-22
- 新增页面底部版本号和更新时间显示
- 新增 README 和 CHANGELOG 文档

## 1.0.0 - 2026-07-22
- 项目初始化：NFC 刷卡签到
- 二维码扫码签到
- 社员信息登记与本地缓存
- 飞书机器人签到通知
- WPS 多维表数据同步
- 扣子工作流集成
