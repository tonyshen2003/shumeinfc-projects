# 「禁止查询＝除名」上线检测流程（v1.20.0）

> 对应改动：worker.js 出口过滤全线生效（members/full · members · member 两路 · detail · find-code · 签到服务端重查人）。
> KV 快照存储不变，活动统计与头像白名单有意保留。
> 本文不入部署（`.wranglerignore` 排除 `*.md`）。测试样本的姓名/卡号/识别码**不要写进本文档**，用环境变量传。

## 0. 前置条件

1. **已推送并部署完成**：GitHub → Cloudflare Workers Builds 构建成功（Workers 控制台看最新部署时间）。
2. **取得 3 名被除名社员的测试样本**（从管理台 `admin.html` → KV `members_full` 搜「禁止查询」，或直接看飞书表），记下：
   - `BLOCKED_NAME` 姓名（须在 691 人中唯一，否则换认读码测）
   - `BLOCKED_CARD` 社员卡号（NFC 十六进制，冒号可有可无）
   - `BLOCKED_CODE` 社员识别码
3. 再取 1 名**正常社员**的同类三样（`NORM_*`）做回归对照。
4. 部署完成 **5 分钟后**再开始测（给 detail 的 300s 边缘缓存留出过期时间）。

```bash
BASE="https://nfc.raspjam.com"
BLOCKED_NAME="…"   BLOCKED_CARD="…"   BLOCKED_CODE="…"
NORM_NAME="…"      NORM_CARD="…"      NORM_CODE="…"
```

## 0.5 自动化对比脚本（推荐主路径，已抓基线）

```bash
node docs/expulsion-check.js capture   # ✅ 已于 2026-11-04 执行，基线存 docs/expulsion-baseline.json
node docs/expulsion-check.js compare   # 部署完成 ≥5 分钟后执行，逐项对比并标注预期变更
```

- 脚本从 /api/members/full **自动发现**被除名者，无需传参；基线文件只存数字/布尔/活动 record_id，不含姓名/卡号/识别码，可入 git。
- 基线已抓（2026-11-04，24 个请求），compare 冒烟通过（33 项全不变）。**推送前若距抓基线超过 1 小时，重跑一次 capture**——飞书数据会被实时维护（实测两次运行间隔就有社员字段被改），漂移会造成假异常（脚本对 1~2 的漂移会给提示）。
- 覆盖：全量条数（691→688）、H5 三张映射（barcodeKeys 预期 −6：每人识别码+认读码各 1）、被除名者 detail×3、正常对照组、**12 个抽样活动的统计数字回归**、photo / avatar / ics / proof-files 回归。
- **数据现状（重要）**：3 名被除名社员中 2 人姓名与卡号已被清空（仅剩识别码+认读码），第 3 人姓名与他人重名 → 按卡号/姓名查人的探针（下表用例 3/4/6 对应的服务端路径）对这 3 人**无数据可测**，脚本已自动跳过。
- **临时标记法（补齐刷卡/姓名路径的真实验证，可选但建议做）**：部署后在飞书社员表找一位自愿测试社员（有卡号、姓名唯一、有年级/部门）临时勾上「禁止查询」→ 再跑一次 `compare` → 脚本会发现 `blocked4` 并自动探测其 uid / q / find-code（应全部 `found:false`；`blocked4.*` 会标为「新增」，人工确认 found 均为 false 即可）→ 取消勾选即恢复（≤60s）。

## 1. 部署前基线（推送前先抓一遍，留数字）

| 项 | 命令 | 记录 |
|---|---|---|
| 全量条数 | `curl -s "$BASE/api/members/full" \| node -p 'JSON.parse(require("fs").readFileSync(0)).items.length'` | 应为 **691** |
| 禁查人数 | 同上把 `.length` 换成 `.filter(i=>{const v=i.fields["禁止查询"];return v===true\|\|v==="true"\|\|v===1}).length` | 应为 **3** |
| 某活动统计 | `curl -s "$BASE/api/activities/detail?id=<任一活动id>" \| node -p 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).stats)'` | 记下 people/totalHours/volunteerHours |
| 日历事件数（全量） | `curl -s "$BASE/calendar/activities.ics?all=1" \| grep -c "^BEGIN:VEVENT"` | 当前为 **206**（默认窗口只有近 365 天，勿用默认值对比） |

> 用例 9 依赖这份基线。没抓也行，但抓了才有对照。**首选 0.5 节的脚本，已抓过基线；本节手工命令作为备用/单点复测。**

## 2. 核心用例（除名生效，6 条全过才算合格）

| # | 检测 | 命令 | 预期 |
|---|---|---|---|
| 1 | App 快照剔除 | `curl -s "$BASE/api/members/full?_t=$(date +%s)" \| node -p 'const j=JSON.parse(require("fs").readFileSync(0));const b=j.items.filter(i=>{const v=i.fields["禁止查询"];return v===true\|\|v==="true"\|\|v===1});j.items.length+" total / "+b.length+" blocked"'` | `688 total / 0 blocked`（`?_t=` 绕 CDN 60s） |
| 2 | H5 映射剔除 | `curl -s "$BASE/api/members?_t=$(date +%s)" > /tmp/m.json; node -e 'const j=require("/tmp/m.json");console.log("card:",j.cardMap[process.env.BLOCKED_CARD]??"absent","code:",j.barcodeMap[process.env.BLOCKED_CODE]??"absent","name:",j.infoMap[process.env.BLOCKED_NAME]??"absent")'` | 三项均 `absent` |
| 3 | 刷卡查人（KV+兜底两路） | `curl -s -w "\nHTTP %{http_code}\n" "$BASE/api/member?uid=$BLOCKED_CARD"` | `{"found":false}`，HTTP 200。⚠️ 当前 3 人无卡号，本用例需临时标记法才能真实验证 |
| 4 | 姓名搜人 | `curl -s -w "\nHTTP %{http_code}\n" "$BASE/api/member?q=$BLOCKED_NAME"` | `{"found":false}`，**HTTP 500（既有行为，非 bug）**；若有同名正常社员会命中那个人，属正常。⚠️ 当前 3 人姓名缺失/重名，本用例需临时标记法 |
| 5 | 档案页 | `curl -s "$BASE/api/members/detail?code=$BLOCKED_CODE"` | `{"found":false}`（旧 found:true 响应在边缘缓存 ≤300s 过期，故等 5 分钟再测） |
| 6 | 识别码找回 | `curl -s "$BASE/api/members/find-code?name=$BLOCKED_NAME&grade=<其年级>&dept=<其部门>"` | `{"found":false}`（无 candidates——禁查在命中前就被跳过）。⚠️ 需姓名唯一，当前 3 人不满足，本用例需临时标记法 |

## 3. 回归用例（不能误伤正常人，6 条）

| # | 检测 | 命令 | 预期 |
|---|---|---|---|
| 7 | 正常人档案 | `curl -s "$BASE/api/members/detail?code=$NORM_CODE"` | `found:true`，字段齐全含 avatarProxy/activities |
| 8 | 正常卡查人 | `curl -s "$BASE/api/member?uid=$NORM_CARD"` | `found:true` + member 信息 |
| 9 | 活动统计没缩水 | 重跑基线第 3 行命令 | people/totalHours/volunteerHours 与基线**逐项一致**（被除名者的历史参与保留） |
| 10 | 日历源正常 | `curl -s "$BASE/calendar/activities.ics?all=1" \| grep -c "^BEGIN:VEVENT"` | 与基线一致（**206**） |
| 11 | 头像代理正常 | 从用例 7 响应取 `avatarProxy` 直接 `curl -sI` | HTTP 200，`cf-cache-status` 任意 |
| 12 | 正常人找回识别码 | `curl -s "$BASE/api/members/find-code?name=$NORM_NAME&grade=<年级>&dept=<部门>"` | `found:true` 且含 `member.code` |

## 4. 手工链路（浏览器 / App，抽查即可）

- **H5 签到页**：正常卡刷卡 → 秒出社员信息；被除名卡 → 走「新卡登记」提示（预期表现）。
  ⚠️ H5 有 **24h 离线缓存**，本地 localStorage 可能仍含旧 cardMap——强刷页面或等过期，这不是 Worker 坏了。
- **DeepMei App**：触发快照刷新后，名人堂/查人中 3 人消失。App 本地快照同样 24h。
- **签到 POST（可选，有副作用）**：`POST /api/checkin` 对禁查卡会返回 `member:null` 并按「未知」写入 WPS + 发飞书群卡片——**会产生真实签到记录**，不想留痕就跳过，用例 3 走的是同一个查人函数 `findMemberByUid`，等效。

## 5. 生效时序速查

| 接口 | 部署后生效延迟 |
|---|---|
| /api/member?uid / ?q、find-code | 即时（无缓存 / no-store） |
| /api/members/full、/api/members | ≤60s（CDN；加 `?_t=时间戳` 立即验证） |
| /api/members/detail | ≤5 分钟（边缘 300s；实际 TTL 不受 max-age 头改写影响，见 AGENTS.md 实测记录） |
| H5 localStorage / App 本地快照 | ≤24h 或手动强刷/刷新快照 |

## 6. 判定与处置

- **通过标准**：核心 6 条全过 + 回归 6 条全过 + 手工抽查无异常 → 验收完成。
- **部分失败时的逃生通道**：飞书表把「禁止查询」取消勾选 → 各出口立即恢复（除 full 的 CDN 60s 与 H5/App 的 24h 本地缓存），不需要回滚代码。
- **彻底回滚**：`git revert <commit> && git push`，自动重新部署。
- 常见误判：用例 4 的 HTTP 500、用例 5 前的 5 分钟空窗、H5 24h 旧缓存——先对照本文时序表，别当 bug 报。
