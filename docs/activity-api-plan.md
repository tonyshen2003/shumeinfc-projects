# 活动页方案：Worker 改进 + 小程序实现

> 探测日期 2026-09-02，数据来自飞书连接器 `lark-cli base` 实时读取。
> **实现状态（2026-09-03）**：Worker 侧已开始实现，见文末「进度」。方案文中「备案 → 直连」一节已废弃，改为云函数中转（域名未备案，既有 API 全部走中转）。

---

## 一、连接器问题结论

飞书连接器**一直都在**，只是它不是 MCP 工具，而是 **Skill 形式**的 CLI 连接器，所以 `ToolSearch` 搜不到。

| 项 | 值 |
| --- | --- |
| Skill 路径 | `~/.workbuddy/connectors/skills/connector-feishu/`（27 个模块，含 `lark-base`） |
| 执行引擎 | `/Users/shensunfeng/.workbuddy/binaries/node/cli-connector-packages/bin/lark-cli`（v1.0.93） |
| 常用命令 | `lark-cli base +field-list` / `+record-list` / `+url-resolve` / `+table-list` |
| 真实 base_token | `J9OobNfJsaDFcos9H7HcXR6wnUb`（Base 名：【树莓社】社员登记和社团活动和资产总数据库） |

两个坑，已解决，后续复用直接抄：

1. **`wrangler.jsonc` 里的 `FEISHU_APP_TOKEN=YUZ4wB3YJiLTq2kUobZccYOKnBb` 是 Wiki token，不是 Base token。**
   直接喂给 `lark-cli base` 会报 `param baseToken is invalid`。
   解析方式：`lark-cli base +url-resolve --url 'https://szzxshumei.feishu.cn/wiki/YUZ4wB3YJiLTq2kUobZccYOKnBb'`。
   （飞书 REST API 侧这个旧格式仍然可用，所以 Worker 不用改。）
2. **`lark-cli base +record-list` 返回的是列式结构**，不是 `[{record_id, fields}]`：
   ```
   .data.fields          // 字段名数组
   .data.field_id_list   // field_id 数组
   .data.data            // 二维数组，每行与 fields 顺序对齐
   .data.record_id_list  // record_id 数组
   .data.has_more
   ```
   且 `--page-size` 上限 **200**（填 500 直接报 validation 错误），分页 token 未暴露，只能取前 200 条。

---

## 二、表结构实况

### 2.1 活动项目表 `tbl30yargX7IZ1kc`（17 字段 / **184 条**记录）

| 字段 | 类型 | 填充率 | 当前 Worker | 备注 |
| --- | --- | --- | --- | --- |
| 项目名称 | text | 100% | ✅ 已用 | |
| 主要活动日期 | datetime | 100% | ✅ 已用 | |
| 项目类型 | select | 100% | ✅ 已用 | 校园新闻采编制作 90 / 树莓社发展建设 34 / 数字媒体学习实践 32 / **树莓社宣传工作** 16 / 影视制作 12 |
| 参与人员 | link → 社员表 | 57% (105) | ❌ | |
| 计入志愿时长 | checkbox | 57% | ❌ | |
| 活动时长（人均） | number | 53% | ❌ | |
| 活动地点/形式 | text | 42% | ❌ | |
| **封面图片（1张）** | attachment | 32% (59) | ❌ | 61 张 ⚠️字段名括号内**无空格**（飞书表头实际值） |
| **活动照片、活动成果和海报** | attachment | 29% (54) | ❌ | 189 张 |
| 项目介绍 | text | 29% | ❌ | 活动详情页正文 |
| 活动成果 | text | 8% | ❌ | |
| 活动记录 | text | 5% | ❌ | 存公众号推文 Markdown 链接 |
| 人数 / 在校社员 / 是否有数据 | lookup | — | ❌ | 派生值，可忽略 |
| 父记录 | link（自关联） | 0% | ❌ | 字段存在但没人用，可做系列子活动 |
| 活动参与明细表 | link → 明细表 | — | ❌ | |

> **注意**：之前从 `/api/members/full` 反推出的"105 个活动"，其实是"有关联参与人员的活动数"（105 / 184 = 57%，完全吻合）。表里实际有 **184 个活动项目**。

### 2.2 活动参与明细表 `tbl5Gr3qoPBatTmt`（11 字段 / 约 1138 条）

| 字段 | 类型 | 当前 Worker |
| --- | --- | --- |
| 活动项目 | link → 项目表 | ✅ 已用（join key） |
| 活动项目名称 | text | ❌ |
| 社员 | link → 社员表 | ✅ 已用（展开成每人一条） |
| 参与时长（小时） | number | ✅ 已用 |
| 志愿服务时长 | number | ✅ 已用 |
| **日期** | lookup | ❌ 当前用的是项目表日期 |
| **参与状态** | select（待确认 / 已确认…） | ❌ |
| **参与角色** | select | ✅ 已读但**恒为空（0%）** |
| **来源** | text（如"批量迁移"） | ❌ |
| **备注** | text（如"迁移自活动表,原人均时长 10.0 小时"） | ❌ |
| 校对班级 | lookup（"登记序号…姓名…班级…部门"） | ❌ 冗余文本 |

### 2.3 图片资产实况（决定方案形态）

| 指标 | 值 |
| --- | --- |
| 有图活动（封面或相册任一） | 70 / 184 = **38%** |
| 图片总数 | 250 张（相册 189 + 封面 61） |
| 总体积 | **738 MB** |
| 平均单张 | **3.91 MB** |
| 超 3 MB 的 | 54 张 |
| 有参与人员的 105 个活动有图率 | **65%** |
| 2024–2026 有图率 | 44%（2025 年最高 63%，2023 年为 0） |

**结论**：图片不能直出。3.91 MB 的原图在小程序里必然卡死，必须在 Worker 侧做缩放。

---

## 三、当前链路的 4 个真实缺口

`buildActivitySnapshot()`（worker.js L526-579）把两张表 join 后展开成"每人每条参与一行"，缓存进 `activity_records_v3`。这条链路撑起了现在的社员档案页（member.wxml L128-158，第一档已完成）。做活动页还差：

1. **活动维度的数据没有被缓存。** KV 里只有"人 → 参与记录"，没有"活动项目"本身。要做活动列表/详情页，必须新缓存活动项目表。
2. **14 个字段被丢弃**，包括全部图片和项目介绍。
3. **没有活动维度的读接口。** 路由表（L850-856）只有 members / member / avatar / refresh / checkin。
4. **`buildActivitySnapshot` 没有做 `isBlocked` 过滤。** 现在的 member 档案只显示"自己"的活动所以没暴露，但一旦做"某活动的参与人名单"，勾选了「禁止查询」的成员就会泄露。**这是必须先补的隐私问题。**

---

## 四、Worker 改进方案

### 4.1 新增 KV Key

| Key | 内容 | 预估体积 |
| --- | --- | --- |
| `activity_projects_v1` | 活动项目表全量（精选字段 + 附件 token） | ~150 KB |
| `activity_detail_v1` | 参与明细表全量（展开成每人一条） | ~250 KB |

> **实现说明（2026-09-03）**：实际实现未保留 `activity_records_v3`，而是将其替换为 `activity_detail_v1`（产出结构完全一致），并新增 `activity_projects_v1`。两表改为一次拉取同建两份，避免每 30 分钟重复拉项目表。

### 4.2 新增 `buildActivityProjectSnapshot(env)`

```js
async function buildActivityProjectSnapshot(env) {
  const rows = await fetchTableRecords(env, ACTIVITY_TABLE_ID);
  const items = rows.map((a) => {
    const f = a.fields;
    return {
      id: a.recordId,
      name: text(f, "项目名称").trim(),
      type: text(f, "项目类型"),
      date: dateText(f["主要活动日期"]),
      intro: text(f, "项目介绍"),
      place: text(f, "活动地点/形式"),
      result: text(f, "活动成果"),
      record: text(f, "活动记录"),      // 公众号推文 Markdown 链接
      hoursPer: numVal(f["活动时长（人均）"]),
      isVolunteer: f["计入志愿时长"] === true,
      people: numVal(f["人数"]),
      coverToken: firstToken(f, "封面图片（1张）"),
      photoTokens: tokensOf(f, "活动照片、活动成果和海报"),
      memberIds: linkIds(f["参与人员"]),  // 用于详情页拼参与人
    };
  }).filter((x) => x.name);
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { updatedAt: Date.now(), items };
}
```

**字段无关设计**：额外存一份 `raw: f`（剔除 link/lookup 大对象），这样飞书以后加列（比如"指导老师""合作方"），前端能直接读到，不用改 Worker。

**`isBlocked` 过滤放在"输出参与人名单"时做，不放在快照构建时做**（快照保留全量，接口层再过滤），否则成员取消勾选后没法回溯。

### 4.3 新增附件 token 辅助函数

```js
function tokensOf(fields, key) {
  const v = fields[key];
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return arr.map((i) => i && i.file_token).filter(Boolean);
}
function firstToken(fields, key) { return tokensOf(fields, key)[0] || ""; }
```

### 4.4 新增 3 个接口

#### `GET /api/activities`

列表页数据，按日期倒序。支持 `?year=2026&type=影视制作&limit=50&offset=0`。

```json
{
  "updatedAt": 1756812345678,
  "total": 184,
  "items": [{
    "id": "recuqxYihN8mgw",
    "name": "苏州中学2021奥体运动会",
    "type": "校园新闻采编制作",
    "date": "2021-09-30",
    "place": "江苏省苏州市奥体中心",
    "hoursPer": 10,
    "people": 21,
    "photoCount": 1,
    "cover": "https://nfc.raspjam.com/api/photo?token=xxx&w=400"
  }]
}
```

`cover` 为空时前端用项目类型色块占位（38% 有图，占位必须做好）。

#### `GET /api/activities/detail?id=<recordId>`

```json
{
  "found": true,
  "activity": {
    "id": "recuqxYihN8mgw",
    "name": "苏州中学2021奥体运动会",
    "type": "校园新闻采编制作",
    "date": "2021-09-30",
    "place": "江苏省苏州市奥体中心",
    "intro": "2021年9月30日，苏州中学树莓社作为唯一的学生社团参与了…",
    "result": "",
    "record": "[2021奥体运动会公众号](https://mp.weixin.qq.com/s/xxx)",
    "hoursPer": 10,
    "isVolunteer": true,
    "photos": [
      { "token": "Bqs7bJyVAoZMTnxo7kdcRtE6nmd", "name": "fb8751957….jpeg",
        "thumb": "https://nfc.raspjam.com/api/photo?token=…&w=400",
        "full":  "https://nfc.raspjam.com/api/photo?token=…&w=1200" }
    ],
    "stats": { "people": 21, "totalHours": 210, "volunteerHours": 42 },
    "participants": [
      { "name": "虞思辰", "grade": "2021级", "dept": "策划与宣传部", "hours": 10, "volunteer": 2 }
    ]
  }
}
```

- `participants` **必须过 `isBlocked` 过滤**（遍历成员快照，剔除勾选「禁止查询」的）。
- `stats` 由 `activity_detail_v1` 按 `activityId` 聚合得出。
- `record` 字段是 Markdown 链接，小程序端用正则抽 URL + 标题，或直接用 `rich-text` 之外的方式处理（Skyline 下 `rich-text` 支持有限，建议只抽链接做按钮）。

#### `GET /api/photo?token=<file_token>&w=<width>`

活动照片代理 + 缩放。复用 `handleAvatar` 的取图逻辑，区别：

| | `/api/avatar` | `/api/photo` |
| --- | --- | --- |
| 白名单来源 | 成员快照「头像」「个人照片」 | `activity_projects_v1` 的 coverToken / photoTokens |
| L2 KV 永久缓存 | ✅ 有（头像小） | ❌ **不能开**（738 MB 会撑爆 KV，且单值上限 25 MB） |
| L1 边缘缓存 | 1 天 | **7 天**（活动照片不变，可以长缓存） |
| 缩放 | 无 | `cf.image` 缩放，默认 w=800 |

缩放用 Cloudflare Image Resizing：

```js
const res = await fetch(tmpDownloadUrl, {
  cf: { image: { width: w, quality: 78, format: "webp", fit: "scale-down" } },
});
```

- 免费计划每月 5,000 次唯一变换。250 张 × 2 尺寸 = 500 次，**免费额度足够**。
- 需要在 Cloudflare 后台确认 Image Resizing 已开启；未开启时降级为不缩放直出（可接受但慢）。
- `w` 建议白名单化 `[200, 400, 800, 1200]`，防止被刷唯一变换次数。

### 4.5 路由与刷新

```js
if (url.pathname === "/api/activities") return handleActivities(request, env);
if (url.pathname === "/api/activities/detail") return handleActivityDetail(request, env, ctx);
if (url.pathname === "/api/photo") return handlePhoto(request, env, ctx);
```

`handleRefresh` 和 `scheduled` 里补两个新 Key 的重建：

```js
const projSnap = await buildActivityProjectSnapshot(env);
await env.SHUMEI_KV.put("activity_projects_v1", JSON.stringify(projSnap));
const detSnap = await buildActivityDetailSnapshot(env);
await env.SHUMEI_KV.put("activity_detail_v1", JSON.stringify(detSnap));
```

Cron 现在是每 30 分钟一次，活动数据变化慢，保持即可。

---

## 五、小程序实现方案

### 5.1 前置决策：域名备案 → 已定案走「云函数中转」

> **已核实（2026-09-03）**：`nfc.raspjam.com` **未 ICP 备案**，且现有社员档案 API（`member` 云函数）就是靠 `wx.cloud.callFunction` 走微信私有协议绕开域名白名单 + 头像转存云存储来工作的。活动页**必须沿用同一条链路**，不能小程序直连 Worker。
>
> 原方案文档里的「方案 A 直连」作废。与现有 `member` 云函数一致的链路：
>
> ```
> 小程序 pages/activity
>    │  wx.cloud.callFunction('activities', { action:'list'|'detail'|'photo' })
>    ▼
> 云函数 activities（腾讯云侧，不受微信域名白名单限制）
>    │  https.get 中转 worker（nfc.raspjam.com）
>    ▼
> Worker：/api/activities / /api/activities/detail / /api/photo
>    │  （活动照片由 Worker 从飞书取图并缩放）
>    ▼
> 云函数把缩略图下载 → cloud.uploadFile 转存云存储 → 返回 cloud:// fileID
> ```
>
> 关键约束（照抄 `member/index.js`）：
> 1. **数据**：云函数用 `https.get` 打 Worker，返回 JSON，可 `wx.setStorageSync` 缓存 10 分钟省资源点。
> 2. **图片**：Worker 返回的 `/api/photo` 指向未备案域名，小程序 `<image>` 无法直载 → 云函数 `activities` 必须在腾讯云侧下载 w=400 缩略图，转存 `cloud.uploadFile` 到云存储，返回 `cloud://` fileID（与头像 `resolveAvatar` 一致）。原图不存（738 MB 不现实），预览大图按需临时拉 Worker。
> 3. **权限**：只返回统计数字，**不返回参与人名单**（isBlocked 隐私），云函数侧天然无名单可泄露。

### 5.2 页面结构

```
miniprogram/pages/
├── card/          现有 · 社员卡
├── member/        现有 · 社员档案（含活动参与记录，第一档已完成）
├── activities/    新增 · 活动列表（第 3 个 tab）
└── activity/      新增 · 活动详情（图片墙）
```

**tabBar 加到 3 项**（社员卡 / 活动 / 社员档案）。注意 Skyline 下 tabBar 图标必须是**不带 alpha 通道的 PNG**，现有两个 tab 的图标已符合，新增的照做即可。

### 5.3 活动列表页 `pages/activities`

- Skyline `scroll-view` + `refresher` 下拉刷新（与 member 页一致的做法）。
- 顶部：年份筛选横滑 chips（`全部 / 2026 / 2025 / 2024 / 更早`）+ 类型筛选。
- 主体：卡片流。有封面的用封面，无封面的用**项目类型色块 + 大号日期**占位（62% 的活动没图，占位设计必须体面，不能是灰方块）。
- 卡片信息：名称、日期、地点/形式、参与人数、时长 pill、照片数量角标。
- 分页：首屏 20 条，滚动到底加载下一页（`?limit=20&offset=n`）。

### 5.4 活动详情页 `pages/activity`

- 头部：封面大图（无图则类型色块）。
- 元信息条：日期 / 地点 / 类型 / 人均时长 / 是否计入志愿时长。
- 项目介绍正文（29% 有，Markdown 里有链接的话做成可点按钮）。
- **图片墙**：瀑布流/九宫格，缩略图走 `w=400`，点击全屏预览走 `w=1200`。
  - 用 `wx.previewImage` 做全屏预览，需要传 `urls` 数组（全尺寸 URL）。
  - 平均每个有图活动 3.5 张，最多 19 张，量不大，`previewImage` 够用。
- **底部统计条**（已按用户决策改为只出统计、不出名单）：参与人次 / 总时长 / 志愿时长。

### 5.5 云函数

**已定案走方案 B（新增 `activities` 云函数），与现有 `member` 同构。**

```
activities/
├── index.js       action: list | detail | photo
└── package.json   依赖 wx-server-sdk
```

- `list`：`https.get` Worker `/api/activities?...` → 返回 JSON；前端缓存 10 分钟。
- `detail`：`https.get` Worker `/api/activities/detail?id=` → 返回 JSON。
- `photo`：`https.get` Worker `/api/photo?token=&w=400` → 下载缩略图 → `cloud.uploadFile` 转存云存储 → 返回 `cloud://` fileID（照抄 `member` 的 `resolveAvatar` 缓存逻辑，按 token 去重，已转存的不重复下载）。

### 5.6 配额影响

按 100 名社员、每人每天看 3 次活动页算：

| 项 | 月消耗 | 资源点 |
| --- | --- | --- |
| 云函数调用 | 9,000 次 | ≈ 12 |
| 数据库读（缓存命中） | 9,000 次 | ≈ 180 |
| 云存储/CDN（缩略图 12 MB） | 首月一次性 | ≈ 3 + 后续 2.5/GB |

**远低于 40,000 点免费额度**（此前测算基线约 2,000 点）。配额不是瓶颈，真正的风险仍是免费环境到期（发布后 15 天转付费 ¥19.9/月）。

---

## 六、实施状态（最终版，2026-09-03 晚）

> 历史注记：本方案曾有一次「重构双快照 + 换 key」的实现被回退（用户要求保持原有刷新逻辑不动）。
> 最终按用户确认的最小增量方案实施，**diff = 334 插入 / 0 删除**，现有代码逐字未动。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | Worker 新增 `activity_projects_v1`（项目完整快照，含封面/相册附件 token） | ✅ 已上线 |
| P2a | Worker 新增 `/api/activities`（列表）+ `/api/activities/detail`（只出统计） | ✅ 已上线 |
| P2b | Worker 新增 `/api/photo`（照片代理+缩放） | ✅ 已上线 |
| P3 | 小程序 `pages/activities` 列表页 + tabBar（第 3 个 tab「活动」） | ✅ 代码完成（待工具预览） |
| P4 | 小程序 `pages/activity` 详情页 + 图片墙 | ✅ 代码完成（待工具预览） |
| P5 | 云函数 `activities`（list/detail 中转 + 照片转存云存储） | ✅ 已部署 |

> 注：与早期草稿不同，最终**没有**新增 `activity_detail_v1`（统计直接复用现有 `activity_records_v3` 现场聚合），也**没有**改动 `buildActivitySnapshot`/`activity_records_v3`/refresh/cron 的原有行为（仅追加一段刷新项目快照）。

---

## 七、待确认清单（已全部关闭）

1. ✅ ~~`raspjam.com` 是否备案？~~ 已核实**未备案**，走云函数中转。
2. ✅ **活动照片取图**：`/api/photo` 与 `/api/avatar` 同机制——项目快照做 token 白名单，`tmp_url` 换直链 → `url` 兜底。实测取图成功，无需额外 drive scope。
   - ⚠️ 注意：连接器 `+record-list` 列式输出把附件精简成 `file_token/name/size`（**别用它判断生产字段**）；生产 REST `records` 附件**带 `tmp_url`**（2026-09-03 抓 `/api/members/full` 实测确认）。
3. ✅ ~~是否展示参与人名单？~~ 已定：**只显示统计数字**（详情响应无 `participants` 字段，实测确认）。
4. ✅ ~~老活动范围？~~ 已定：**全部 184 个**（`year=early` 折叠 2023 及更早，实测 75 条）。

---

## 八、线上验证结果（2026-09-03 16:49）

**旧接口零影响**：部署前后基线对比（`docs/api-baseline/`，`00-grab.sh` 重放 + node diff 脚本，剔除 `updatedAt`）：11/11 个旧接口返回逐字节一致。

**新接口（已实测通过）**：
- `/api/activities`：total 184、facets 年份/类型分布正确、`year=early`=75 条（2018-2023）、`type=影视制作`=12 条
- `/api/activities/detail`：stats 正确、无 participants 字段、photos 带 thumb(w=400)/full(w=1200)
- `/api/photo`：取图成功（400x266 JPEG ~33KB）；假 token 404；**成员头像 token 不能越权访问活动照片**（白名单隔离）；非法 w 回退 800；二次访问命中边缘缓存（3.8s → 0.6s）
- 意外发现：Cloudflare Image Resizing **实际已开启**（README 曾写未启用），w=400/800 均输出缩放图

**云函数 `activities`**（本地 mock + 真实 worker 端到端验证）：
- list/detail 转发参数正确；照片转存 cloud:// 成功（w=400 封面 / w=800 照片墙）；缓存 key 按 `token_w` 隔离；二次调用命中缓存零重复上传；detail 不存在返回 `found:false`

**实现要点**（对照最终代码）：
- Worker：`worker.js` 常量区新增 `ACTIVITY_PROJECTS_KV_KEY`；新增 `attachmentsOf` / `buildActivityProjectSnapshot` / `getActivityProjectSnapshot` / `aggregateActivityStats` / `round1` / `resolvePhotoUrl` / `handleActivities` / `handleActivityDetail` / `handlePhoto`；`handleRefresh` 与 `scheduled` 各追加一段项目快照刷新；文件头注释补 3 个新 API。
- 小程序：`app.json`（pages + tabBar 3 项：社员卡/活动/社员档案）；`pages/activities`（列表：年份 chips、卡片流、类型色块占位、分页、下拉刷新）；`pages/activity`（详情：封面/统计条/介绍/照片墙+previewImage）；`utils/activities.ts`（`getActivities`/`getActivityDetail`）；`cloudfunctions/activities`（list/detail + `ensurePhoto` 转存，集合 `activity_photo`，单次限 6 张渐进补齐）；tab 图标 `activity-gray/on.png`（81x81 RGB 无 alpha）。
- 字段名按飞书实际值（`封面图片（1张）` 无空格、`树莓社宣传工作`）。
