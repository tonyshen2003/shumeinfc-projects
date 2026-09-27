# 日程订阅（iCalendar）技术调研与树莓社落地方案

> 调研对象：`https://pro.hori.cloud/share/calendarics/v1`
> 调研日期：2026-09-28 ｜ 撰写人：WorkBuddy
> 目标：判断这套「日历订阅链接」的技术实现，并给出树莓社（nfc.raspjam.com / Cloudflare Worker + 飞书多维表）的落地排期。

---

## 0. 一句话结论

对方是**一个动态生成的 iCalendar（RFC 5545）订阅源**：后端（ThinkPHP 5.1 + nginx）在每次请求时把数据库里的项目表渲染成 `.ics` 文本直接返回，无任何鉴权、无缓存头、无增量机制。技术上非常朴素（全部是全天事件、8 个属性、438 条），**核心难点不在协议而在「UID 稳定性 + 缓存 + 隐私分级」**。

树莓社完全可以照做，而且因为我们已经有 `activity_projects_v1` 的 KV 快照和 Worker 边缘缓存，改造量很小：**公开版日历 0 新增数据源，约 150 行 Worker 代码即可上线**。

---

## 1. 对方链接的技术解剖

### 1.1 实测响应

| 项 | 实测值 |
|---|---|
| 协议 / 状态 | HTTP/2 200 |
| 服务器 | nginx（HSTS、`alt-svc` 支持 HTTP/3） |
| `Content-Type` | **`text/html; charset=utf-8`**（⚠️ 应为 `text/calendar`） |
| 体积 | 120,083 字节 / 4,200 行 / 438 个 VEVENT |
| 缓存头 | **无** `Cache-Control` / `ETag` / `Last-Modified` |
| 行尾 | CRLF（符合 RFC 5545） |
| 最长行 | 76 字节（含 CR）= 75 octets 折叠，符合规范 |
| 动态性 | `DTSTAMP:20260927T195232Z` 与请求时刻完全一致 → **每次请求实时渲染**，非静态文件 |

### 1.2 ICS 内容结构

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//HoriProjects
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VTIMEZONE
TZID:America/New_York          ← 内嵌夏令时规则（2× RRULE）
...
END:VTIMEZONE
BEGIN:VEVENT
UID:HMG_PRJ_202201001          ← 业务主键，格式：HMG_PRJ_<年月><三位序号>
DTSTART:20220103               ← VALUE=DATE，全天事件
DTEND:20220104                 ← 排他结束日（= 结束日 + 1），符合规范
SUMMARY:已结束:萧然学子联盟北京站   ← 状态前缀写进标题
DESCRIPTION:HMG_PRJ_202201001 萧然学子联盟北京站\n客户共青团杭州市萧山区委员会
DTSTAMP:20260927T195232Z
ATTENDEE;CN=Us:mailto:us@hori.media   ← ⚠️ 每个事件都挂一个"自己人"
END:VEVENT
... × 438
END:VCALENDAR
```

**属性全集只有 8 个**（VCALENDAR 级 4 个 + VEVENT 级 8 个）：
`VERSION / PRODID / CALSCALE / METHOD / UID / DTSTART / DTEND / SUMMARY / DESCRIPTION / DTSTAMP / ATTENDEE`
（另含 VTIMEZONE 内的 `TZID / DTSTART / RRULE / TZOFFSETTO / TZOFFSETFROM`）

**完全没有**：`LOCATION`、`URL`、`STATUS`、`SEQUENCE`、`LAST-MODIFIED`、`VALARM`、`X-WR-CALNAME`、`REFRESH-INTERVAL`、`X-PUBLISHED-TTL`、`ORGANIZER`。

### 1.3 后端是什么

- 站点根 `/` 返回 ThinkPHP V5.1 的默认欢迎页 → **PHP + ThinkPHP 5.1**，nginx 反代。
- 路径 `/share/calendarics/v1` 符合 ThinkPHP 路由风格：`/share`（模块或分组）/ `calendarics`（控制器）/ `v1`（操作或参数）。
- 路径探测结果：
  - `/share/calendarics` → 404
  - `/share/calendarics/v0` → 404
  - `/share/calendarics/v1` → 200，438 条
  - `/share/calendarics/v2` → **200 但 body 为空**（0 字节）
  - `/share/calendarics/v1?token=x` → 与不带参数完全一致

  → 说明 `v1` / `v2` 是**日历通道标识**（不同项目组 / 不同团队各一条），不是版本号；**且不做任何鉴权**，任意参数都被忽略。

### 1.4 它做得对的地方（值得抄）

1. **UID 用业务主键**（`HMG_PRJ_202201001`）而不是随机数 —— 这是订阅日历能"原地更新而不是重复堆积"的唯一关键。
2. **全天事件用 `VALUE=DATE` + 排他 `DTEND`**（结束日 +1），正确处理了跨天活动。
3. **75 octets 折叠 + CRLF**，严格符合 RFC 5545。
4. **`METHOD:PUBLISH`**（而非 `REQUEST`），订阅场景正确 —— 不会在客户端产生"待接受邀请"。
5. **状态编码进 SUMMARY**（`已结束:` / `未确定:` 前缀），在没有 STATUS 字段的情况下是个土但有效的办法。
6. 内嵌完整 `VTIMEZONE`（含 DST RRULE），跨时区客户端不会漂。

### 1.5 它的问题（我们不要重犯）

| # | 问题 | 后果 | 我们的做法 |
|---|---|---|---|
| 1 | `Content-Type: text/html` | 部分客户端/爬虫会当网页下载或直接拒绝 | `text/calendar; charset=utf-8` |
| 2 | 无 `X-WR-CALNAME` | 订阅后日历名显示成一长串 URL | 加 `X-WR-CALNAME:树莓社活动` |
| 3 | 无 `REFRESH-INTERVAL` / `X-PUBLISHED-TTL` | 客户端刷新频率不可控（Google 默认 ~24h） | 两件套都写，`PT4H` |
| 4 | 无 `SEQUENCE` / `LAST-MODIFIED` | 改了活动，客户端可能不更新 | `SEQUENCE` + `LAST-MODIFIED` 齐上 |
| 5 | 无 `STATUS` | 活动取消只能删事件 → 客户端残留旧条目 | 取消用 `STATUS:CANCELLED` 保留下发 |
| 6 | `ATTENDEE:mailto:us@hori.media` 滥用 | 客户端可能误判为"待处理邀请"，Outlook 会弹提醒 | 不写 ATTENDEE（PUBLISH 语义下无意义） |
| 7 | 无任何缓存头 + 120KB 全量 | 每次订阅轮询都是全表渲染，DB 压力大 | Cloudflare Cache API + `max-age=300` |
| 8 | 无鉴权，链接即全量数据 | **客户名（Bytedance、兰蔻、和黄医药…）全部公开** | 分级订阅 + token |
| 9 | 无 `LOCATION` / `URL` | 日历里看不到地点，点不回详情 | 都补上，URL 指回 H5 |

> 补充：它的中文折叠是**字节级硬切**（`客户共` / `青团` 被切成两行），展开后仍是合法 UTF-8，所以不会真出错，但说明实现很朴素。我们按码点边界折，更稳。

---

## 2. 这类东西的通用套路（心智模型）

```
数据源（DB / 多维表）
   ↓  定时/触发 生成快照
快照缓存（KV / Redis）
   ↓  每次被订阅端拉取时
ICS 渲染器（RFC 5545：CRLF + 75 octet 折叠 + 转义 + 稳定 UID）
   ↓  text/calendar
CDN / 边缘缓存
   ↓  webcal:// 或 https://
客户端（iCloud / Google / Outlook / 系统日历）按 TTL 轮询，按 UID 做增量合并
```

三个必须想清楚的点：

1. **UID 稳定** —— 决定"更新"还是"重复"。
2. **拉取频率** —— 订阅日历是**客户端主动轮询**，不是推送。`X-PUBLISHED-TTL` 只是建议值，Google 实际仍按 ~24h 拉。
3. **删除语义** —— 事件取消不要直接消失，要用 `STATUS:CANCELLED` 下发一次，否则用户日历里永远留着僵尸条目。

---

## 3. 树莓社方案

### 3.1 分级设计（先做第一级）

| 级别 | URL | 内容 | 鉴权 | 优先级 |
|---|---|---|---|---|
| **L1 公开活动日历** | `/calendar/activities.ics` | 全部活动：名称 / 日期 / 地点 / 简介 / 人均时长 / 详情链接 | 无（链接即权限） | **P0** |
| **L2 个人参与日历** | `/calendar/my/<token>.ics` | 该社员**已参加**的活动 + 本人时长 + 未来活动提醒 | token（可吊销/轮换） | P1 |
| L3 内部排期日历 | `/calendar/internal/<token>.ics` | 筹备中/未公开活动，仅管理层 | token + 白名单 | P2（可不做） |

建议 **L1 先上**，因为它零隐私风险、零鉴权成本，且立刻能给社员用（"订阅一次，社团活动自动进日历"）。

### 3.2 数据源与字段映射

现有 KV 快照 `activity_projects_v1`（来自飞书活动项目表 `tbl30yargX7IZ1kc`，184 条）已有：

| 飞书列 | 快照字段 | → ICS |
|---|---|---|
| 项目名称 | `name` | `SUMMARY` |
| 主要活动日期 | `date`（YYYY-MM-DD） | `DTSTART;VALUE=DATE` / `DTEND`（+1 天） |
| 项目类型 | `type` | `CATEGORIES` |
| 活动地点/形式 | `place` | `LOCATION` |
| 项目介绍 | `intro` | `DESCRIPTION` |
| 活动时长（人均） | `hoursPer` | 写进 `DESCRIPTION` |
| 计入志愿时长 | `isVolunteer` | 写进 `DESCRIPTION`（志愿标记） |
| record_id | `id` | **`UID:act-<id>@nfc.raspjam.com`** |

**飞书需要补的 3 列**（不改也能上，改了才完整）：

| 新增列 | 用途 | 不做的降级方案 |
|---|---|---|
| 「活动结束日期」 | 多日活动（如 10/23–10/30） | 全部按单日全天处理 |
| 「活动开始时间」 | 精确到钟点的活动（例会 16:30） | 全部按全天处理 |
| 「活动状态」（筹备/开放/已结束/取消） | `STATUS` + 取消语义 | 不输出 STATUS，不下发取消 |

> 提醒：改飞书表头前务必同步 `worker.js` 里的字段名（AGENTS.md 已强调：字段名与表头逐字符一致）。

### 3.3 ICS 输出模板（我们比对方多出的部分加粗）

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ShumeiNFC//Activity Calendar//CN
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:树莓社活动
X-WR-CALDESC:苏州中学树莓社活动日程
X-WR-TIMEZONE:Asia/Shanghai
REFRESH-INTERVAL;VALUE=DURATION:PT4H
X-PUBLISHED-TTL:PT4H
BEGIN:VTIMEZONE
TZID:Asia/Shanghai
BEGIN:STANDARD
DTSTART:19910915T000000
TZOFFSETFROM:+0900
TZOFFSETTO:+0800
TZNAME:CST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:act-recXXXXXXXX@nfc.raspjam.com
DTSTAMP:20260928T035200Z
LAST-MODIFIED:20260928T035200Z
SEQUENCE:0
DTSTART;VALUE=DATE:20261023
DTEND;VALUE=DATE:20261024
SUMMARY:树莓社 10 月例会
LOCATION:苏州中学 科学楼 3F
DESCRIPTION:类型：例会\n地点/形式：线下\n人均时长：2 小时\n计入志愿时长\n\n项目介绍…
CATEGORIES:例会
URL;VALUE=URI:https://nfc.raspjam.com/?activity=recXXXXXXXX
STATUS:CONFIRMED
TRANSP:TRANSPARENT
END:VEVENT
END:VCALENDAR
```

**关键决策说明**：
- **全天 vs 定时**：现阶段只有「主要活动日期」单日期 → 全部用全天事件（与对方同策略）。等飞书补了时间列再切 `DTSTART;TZID=Asia/Shanghai:...T163000`。
- **不加 `VALARM`**：订阅日历的提醒会打扰所有订阅者，且 Google/iCloud 对订阅日历的 VALARM 支持不一致。需要提醒的用户自己在本机日历里设。
- **`TRANSP:TRANSPARENT`**：全天活动默认占用"忙碌"，设为透明更符合校园活动语义。
- **`X-WR-TIMEZONE` + 内嵌 VTIMEZONE**：中国无夏令时，VTIMEZONE 只需一个 STANDARD 段（对方那个 America/New_York 的 DST 段对我们完全多余）。

### 3.4 缓存与刷新

沿用 `handleActivities` 现有模式（Worker 内 `caches.default` + `_cache/` 前缀 key）：

- 缓存 key：`https://<host>/_cache/calendar/<scope>/<query>`
- 响应头：`Cache-Control: public, max-age=300` （与活动列表接口一致）
- 失效：`/api/refresh` 被触发（飞书自动化 / Cron / 管理台）时，连带 purge 日历 cache key
- 体积预估：184 个活动 ≈ 50KB（对方 438 条 120KB），全量下发无压力
- 可选：默认只输出「当前学年起 + 未来」，用 `?from=2026` 控制，进一步压缩

### 3.5 隐私红线（硬约束）

- **L1 公开日历绝不出现**：社员姓名、识别码、卡号、手机号、参与名单、个人志愿时长、证明文件。
- **L2 个人链接不能明文带识别码**：`/calendar/my?code=xxx` 一律禁止，必须走 token。
- **token 强度**：128 bit 随机（`crypto.getRandomValues`），存 KV `sub:<token> → memberCode`，管理台可一键吊销/轮换。
- **枚举防护**：token 无效时返回 404 + 空日历，不回显任何"该社员是否存在"的信息。
- 订阅链接一旦外泄（日历客户端/浏览器历史/截图），等于数据外泄 → 所以 L1 才必须先做。

### 3.6 代码接入点

| 位置 | 改动 |
|---|---|
| `worker.js` 头注释 | 新增 2 行接口说明（项目约定：头注释 = 接口全集） |
| `worker.js` ~1850 行路由 | `if (url.pathname === "/calendar/activities.ics") return handleCalendarIcs(request, env, ctx);` |
| `worker.js` 新增 | `handleCalendarIcs()` + `foldLine()` + `escText()` + `buildVEvent()`（约 150 行） |
| `wrangler.jsonc` | **不动**（routes / kv_namespaces / crons 一律不动） |
| `README.md` | 接口表新增一行 + KV/缓存说明 |
| `CHANGELOG.md` | 新增版本条目 |
| `admin.html`（P1） | 「生成订阅链接 / 吊销」按钮 |

核心工具函数骨架（Worker 环境，ESM）：

```js
const CRLF = "\r\n";

/** RFC 5545 文本转义：\ ; , 与换行 */
const escText = (s) =>
  String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;")
                 .replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** 75 octets 折叠，按 UTF-8 码点边界切，续行以单个空格开头 */
function foldLine(line) {
  const buf = new TextEncoder().encode(line);
  if (buf.length <= 75) return line;
  const out = [];
  let start = 0, limit = 75;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    if (end < buf.length) {
      while (end > start && (buf[end] & 0xc0) === 0x80) end--; // 不切断多字节序列
      if (end === start) end = Math.min(start + limit, buf.length);
    }
    out.push(new TextDecoder().decode(buf.subarray(start, end)));
    start = end;
    limit = 74; // 续行首字符是空格，占 1 字节
  }
  return out.join(CRLF + " ");
}

/** 2026-10-23 → 20261023；+1 天用于排他 DTEND */
const toDateVal = (d) => String(d || "").replace(/-/g, "");
function plusOneDay(d) {
  const t = Date.parse(String(d) + "T00:00:00Z") + 86400000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
}
const stampZ = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
```

---

## 4. 排期建议

| 阶段 | 内容 | 产出 | 依赖 |
|---|---|---|---|
| **阶段 1（P0，最快当天）** | L1 公开日历：Worker 新增 `/calendar/activities.ics`，读 `activity_projects_v1` 快照，套用现有缓存模式 | 一个可直接订阅的链接 | 无 |
| **阶段 2** | 飞书补 3 列（结束日期 / 开始时间 / 状态）→ 支持多日、定时、`STATUS:CANCELLED` | 日历语义完整 | 需改飞书表头（同步代码字段名） |
| **阶段 3（P1）** | L2 个人订阅：token 生成/吊销 + KV 映射 + 管理台按钮 | 社员可在 App / 群里一键订阅自己的活动 | 阶段 1 |
| **阶段 4** | 入口与文档：H5 页底部"订阅日历"、小程序内一键 `webcal://`、使用说明页 | 真正有人用起来 | 阶段 1/3 |
| **阶段 5** | 文档同步：worker.js 头注释 → README → CHANGELOG | 符合项目约定 | 随每阶段做 |

**我的建议：先只做阶段 1 + 阶段 5，用一两天验证真实客户端表现，再决定要不要投 2/3/4。** 因为订阅日历的价值取决于"社员真的会订阅"，而这个只有上线后才知道。

---

## 5. 验收清单（上线前逐项打勾）

- [ ] `Content-Type` 为 `text/calendar; charset=utf-8`（不是 text/html）
- [ ] 行尾 CRLF，无一行超过 75 octets，折叠不切断中文字符
- [ ] `SUMMARY` / `DESCRIPTION` 中含 `\` `;` `,` 换行时已正确转义（拿一条带逗号的活动试）
- [ ] UID 稳定：改一次活动名称后重新订阅 → 客户端**原地更新**，不出现第二条
- [ ] 订阅后日历名称显示为「树莓社活动」而非 URL（`X-WR-CALNAME` 生效）
- [ ] macOS 日历（webcal://）订阅成功；Google Calendar 通过 URL 添加成功
- [ ] iOS 日历订阅成功；Android 用 https:// 直链可用
- [ ] 缓存生效：连续两次请求第二次命中 `caches.default`（响应头/日志确认）
- [ ] `/api/refresh` 后日历内容随之更新
- [ ] L1 输出中**不含**任何社员个人信息（人工通读一遍 DESCRIPTION）
- [ ] 用 Python `icalendar` 库 parse 一遍无异常：`python3 -c "from icalendar import Calendar; Calendar.from_ical(open('a.ics','rb').read())"`

---

## 附：客户端兼容性速查

| 客户端 | 链接形式 | 刷新频率 | 备注 |
|---|---|---|---|
| Apple 日历（iOS/macOS） | `webcal://` 或 `https://` | 约 15 分钟 ~ 数小时，不可控 | 支持最好，首选 |
| Google Calendar | 仅 `https://`，"通过 URL 添加" | **约 24 小时**，且必须公开可访问 | 对 Content-Type 敏感 |
| Outlook 365 | `https://`（webcal 亦可） | 约 数小时 | 对异常属性容忍度低 |
| 飞书日历 / 钉钉日历 | 导入 .ics 文件为主 | 通常不支持持续订阅 | 需"下载文件再导入"路径 |

> 因为 Google 只认 `https://`，建议对外只发 `https://nfc.raspjam.com/calendar/activities.ics`；iOS 用户想用 `webcal://` 时前端把协议前缀换掉即可（同一个 URL）。

---

# 附 B：最小实施方案（v1，2026-09-28 定稿）

**原则**：先做到与调研对象同等水平 —— 全天事件、单条公开链接、无鉴权无加密无提醒。飞书加列 + Worker 加一个只读接口，其余一律不做。

## B.1 数据现状（2026-09-28 实测 /api/activities）

| 项 | 实测值 |
|---|---|
| 活动总数 | **196 条**（非文档所载 184） |
| 「主要活动日期」填充率 | **100%**，格式统一 `YYYY-MM-DD` |
| 日期区间 | 2018-09-15 ~ 2026-09-25，**无任何未来活动** |
| 「活动地点/形式」填充率 | 82 / 196（114 条为空） |
| 项目类型分布 | 校园新闻采编制作 92 · 树莓社发展建设 39 · 数字媒体学习实践 34 · 宣传工作 18 · 影视制作 13 |
| 近两年构成 | 2026 年 42 条、2025 年 45 条，其中「校园新闻采编制作」占 39 / 87（45%） |

## B.2 三项决策

### 决策 1：结束日期 —— 加列，同时写死兜底

| | 结论 |
|---|---|
| 飞书 | 新增「活动结束日期」日期型列，**可空**，历史数据不必补 |
| 代码 | `const end = endDate || date`，`DTEND = end + 1 天` |
| 理由 | 确实存在长周期/多日活动（如「树莓酱二创作品常驻征集（2026-2027 学年第一学期）」「2026 上半年宣策部活动综合项目」「Filmarathon2026 参赛」），单日条语义不对；但占比仅约 5%，所以**不强制填**，留空即退化为单日 |

### 决策 2：公开控制 —— 加列，但用**反向语义**

| | 结论 |
|---|---|
| 飞书 | 新增「**隐藏日程**」复选框（不是「是否公开日程」） |
| 代码 | `if (f["隐藏日程"] === true) continue;` |
| 理由 | 正向列要先把 196 条历史全部勾上，且**每次新增活动都必须记得勾，漏勾 = 静默不进日历**；反向列开箱即用（新增默认进日历），只把不想公开的少数勾掉。另外飞书复选框空值可能是 `undefined` 也可能是 `false`，正向判定有歧义，反向判定 `=== true` 无歧义 |

> 若坚持用「公开日程」正向命名：需先批量勾选全部 196 条历史记录，并把"新增必须勾选"写进社团录入规范。不推荐。

### 决策 3：时间窗口 —— 默认「近 1 年 + 全部未来」

| | 结论 |
|---|---|
| 默认 | `date >= 今天 - 365 天`，约 50 条 |
| 参数 | `?from=2024` 指定起始年份；`?all=1` 输出全部 196 条 |
| 理由 | 全量下发会把日历变成档案库（2018 年的活动出现在今日视图附近毫无意义）；档案查询已有 H5 活动页 |

## B.3 兜底规则（三处，缺一不可）

| 输入字段 | 现状 | 兜底行为 |
|---|---|---|
| 活动结束日期 | 新增列，多数留空 | 留空 → 用「主要活动日期」，`DTEND = 日期 + 1` |
| 活动地点/形式 | 114 / 196 为空 | 为空 → **不输出 `LOCATION` 行**（不要写"待定""暂无"污染日历） |
| 活动开始时间 | 完全没有 | → 全天事件 `DTSTART;VALUE=DATE` |

## B.4 接口形态

```
GET /calendar/activities.ics            默认：近 1 年 + 未来
GET /calendar/activities.ics?from=2024  指定起始年份
GET /calendar/activities.ics?all=1      全量 196 条
GET /calendar/activities.ics?type=例会  按项目类型过滤（精确匹配）
```

响应：`Content-Type: text/calendar; charset=utf-8`，`Cache-Control: public, max-age=300`。

## B.5 代码改动清单（最小）

| 位置 | 改动 |
|---|---|
| 飞书活动项目表 | 加 2 列：「活动结束日期」（日期）、「隐藏日程」（复选框） |
| `buildActivityProjectSnapshot()` | 快照增加 `endDate`、`hidden` 两个字段 |
| 新增 `handleCalendarIcs()` | 过滤 → 渲染 VEVENT → 输出；约 120 行 |
| 新增工具函数 | `foldLine()`（75 octet 折叠，不切断中文）、`escText()`（转义 `\ ; ,` 与换行）、`toDateVal()` / `plusOneDay()` |
| 路由（~1850 行） | 加 1 行分支 |
| 缓存 | 复用 `caches.default` + `_cache/calendar/...` key，与 `handleActivities` 同模式 |
| 文档 | worker.js 头注释 + README 接口表 + CHANGELOG 版本条目 |
| `wrangler.jsonc` | **不动** |

## B.6 本轮明确不做

- token / 加密 / 个人订阅链接（L2）
- 飞书「活动开始时间」列（先全部按全天事件）
- `VALARM` 提醒（订阅日历的提醒会打扰所有人）
- `STATUS` / 取消语义（等飞书有「活动状态」列再说）
- `SEQUENCE` / `LAST-MODIFIED` 增量（v1 先靠稳定 UID + 全量覆盖）

## B.7 上线前必读：两件比技术更重要的事

1. **日历里现在不会有"接下来要做什么"。** 196 条记录全是事后录入，最新一条是 3 天前的 2026-09-25。订阅后打开日历，看到的全是过去。要让订阅日历真正有用，社团必须**在活动发生前就把记录建好并填未来日期** —— 这条是运营要求，不是代码能解决的。
2. **「校园新闻采编制作」近两年占 45%**（"问道山下第 X 期""高一羽毛球班赛拍摄"等），对不参与拍摄的社员是噪音，但对拍摄部成员其实是有效日程。上线后先用「隐藏日程」批量勾掉明确不该进日历的，剩下的观察一两周再调整。

## B.8 飞书字段清单（v1 最终：全部全天事件）

**最终决策**：所有活动一律按**全天事件**输出 —— `DTSTART;VALUE=DATE:20260923` + `DTEND;VALUE:20260924`（结束日 + 1，iCal 排他结束）。
因此**不新增任何"时分秒"字段**。注意：全天 ≠ 单日，多日/长周期活动仍靠「活动结束日期」表达跨度。

### 需要新增的字段（活动项目表 `tbl30yargX7IZ1kc`，共 2 列）

| 列名（逐字符一致） | 字段类型 | 必填 | 默认值 | 用途 | 留空/不勾时的行为 |
|---|---|---|---|---|---|
| `活动结束日期` | 日期 | 否 | 空 | 多日、长周期活动的最后一天 | 回退为「主要活动日期」，按**单日全天**输出 |
| `隐藏日程` | 复选框 | 否 | 不勾选 | 勾选后该活动**不出现**在订阅日历 | 不勾选 = 正常进日历 |

**建列注意事项**

1. 「活动结束日期」与现有「主要活动日期」用同样的日期字段配置即可。Worker 的 `dateText()` 同时兼容 `2026-09-25` 字符串与秒/毫秒时间戳（按北京时间 +8h 换算），无需特殊设置。
2. 字段名必须与代码**逐字符一致**（全角/半角、空格都要对）—— 这是本项目既有坑，改表头前先确认代码里的字符串。
3. 建完列后触发一次 `POST /api/refresh`（或用管理台刷新）重建 `activity_projects_v1` 快照，否则新字段读不到。
4. 「隐藏日程」是**反向语义**：勾上 = 不进日历。

### 不新增的字段（本轮明确排除）

| 曾考虑 | 类型 | 不加的理由 |
|---|---|---|
| 活动开始时间 / 活动结束时间 | 日期（含时间） | 已决定全部按全天事件，不需要时分秒 |
| 活动状态（筹备/开放/已结束/取消） | 单选 | 等确实需要"取消、推迟"语义时再加，届时配 `STATUS:CANCELLED` 一起上 |
| 日程标题 | 文本 | 直接复用「项目名称」，避免两处维护 |
| 公开日程（正向复选框） | 复选框 | 需批量勾选 196 条且新增漏勾会静默消失，已改用反向「隐藏日程」 |

### 现有字段（只读，不改动）

| 飞书列名 | 类型 | 填充情况（196 条实测） | 输出位置 |
|---|---|---|---|
| 项目名称 | 文本 | 196 / 196 | `SUMMARY` |
| 主要活动日期 | 日期 | 196 / 196，格式统一 `YYYY-MM-DD` | `DTSTART;VALUE=DATE` |
| 项目类型 | 单选 | 196 / 196 | `CATEGORIES` |
| 活动地点/形式 | 文本 | **82 / 196**（114 条空） | `LOCATION`（空则整行不输出） |
| 项目介绍 | 文本 | 未在列表接口暴露，需实表确认 | `DESCRIPTION`（空则省略该段） |
| 活动时长（人均） | 数字 | 107 条 > 0，89 条为 0 或空 | `DESCRIPTION` 内一行（为 0 时不写） |
| 计入志愿时长 | 复选框 | 未在列表接口暴露 | `DESCRIPTION` 内一行（未勾不写） |
| record_id | 系统字段 | 196 / 196，如 `recvwrI2ofWLVE` | `UID:act-recvwrI2ofWLVE@nfc.raspjam.com` |

> `UID` 规则：`act-<record_id>@nfc.raspjam.com`。record_id 是飞书记录的稳定主键，只要记录不删除就永不变 —— 这是订阅日历能"原地更新而不是重复堆积"的关键。

## B.9 上线后的订阅链接形态

### 主链接

> 已于 2026-09-28 实现（v1.19.0），`worker.js` 中 `handleCalendarIcs()` + `buildIcsBody()`。

```
https://nfc.raspjam.com/calendar/activities.ics
```

对外**统一发 https 版本**（Google 日历只认 `https://`，不认 `webcal://`）。iOS / macOS 想一键唤起日历 App 时，把协议前缀换成 `webcal://` 即可，路径完全相同：

```
webcal://nfc.raspjam.com/calendar/activities.ics
```

### 可选参数

| 链接 | 内容 |
|---|---|
| `.../activities.ics` | 默认：近 365 天 + 全部未来，实测 **65 条**（2026-09-28，起算 2025-09-28） |
| `.../activities.ics?from=2024` | 2024 年起至今，实测 121 条 |
| `.../activities.ics?all=1` | 全部 196 条 |
| `.../activities.ics?type=校园新闻采编制作` | 只订阅某一类型（中文需 URL 编码） |

### 订阅者在日历里看到什么

- **日历名称**：「树莓社活动」（来自 `X-WR-CALNAME`），不会出现一长串 URL
- **每条活动**：全天条，标题 = 项目名称；有地点时显示地点；点开详情有类型、人均时长、简介与回链
- **刷新**：建议值 4 小时（`REFRESH-INTERVAL` / `X-PUBLISHED-TTL`），实际由客户端决定 —— Apple 日历较快，Google 日历约 24 小时
  - 线上实测（2026-09-28）：响应命中 Worker 缓存时（`cf-cache-status: HIT`），Cloudflare 会把 `Cache-Control: max-age` 统一改写成 **18000 秒（5 小时）**；未命中时才是代码里的 300。`/api/activities` 同样如此，属既有 zone 行为，非本接口引入

### 各客户端添加方式

| 客户端 | 路径 |
|---|---|
| iOS 日历 | 设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅日历，粘贴 URL |
| macOS 日历 | 文件 → 新建日历订阅，粘贴 URL |
| Google 日历 | 网页版 → 其他日历 → "+" → 通过 URL 添加（**首次同步可能要等约 24 小时**） |
| Android | 无原生订阅入口，通常靠 Google 日历账号同步，或用第三方 ICS 订阅 App |

### 一个必须强调的前提

这是**无鉴权公开链接** —— 任何人拿到都能订阅。因此日历里**只会**有活动名称、日期、地点、简介这类公开信息，绝不会出现社员姓名、识别码、参与名单或个人时长。这也是 v1 只做公开活动日历、不碰个人订阅的原因。
