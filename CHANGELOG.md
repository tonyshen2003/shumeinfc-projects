# 更新日志

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
