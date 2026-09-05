/**
 * Cloudflare Worker — 静态站点 + 成员查询 API
 * GET /api/members              → 返回全部成员（供前端离线缓存）
 * GET /api/members/full         → 返回全部成员原始记录（含 record_id，供 App 本地快照）
 * GET /api/member?uid=<卡号>     → 查询飞书多维表
 * GET /api/member?q=<姓名>       → 搜索飞书多维表
 * GET /api/avatar?token=<token>  → 头像代理直链（边缘缓存 1 天 + KV 永久，飞书删图仍可访问）
 * GET /api/activities            → 活动列表（年份/类型/关键词筛选 + 分页 + 筛选项）[2026-09-03]
 * GET /api/activities/detail?id= → 活动详情（只出统计数字与照片，不出参与人名单）[2026-09-03]
 * GET /api/photo?token=&w=       → 活动照片代理 + 缩放（边缘缓存 7 天，不写 KV）[2026-09-03]
 * GET /api/member/proofs?code=   → 社员可下载的证明清单（发布时间 >= 入社日期）[2026-09-06]
 * GET /api/file?token=           → 社员证明附件原样代理 PDF（白名单，边缘缓存 7 天）[2026-09-06]
 * POST /api/checkin             → 签到提交（写 WPS + 发飞书通知）
 * POST /api/refresh             → 触发刷新（飞书自动化 HTTP 调用，拉全量写 KV）
 */

let cachedToken = null;
let tokenExpiry = 0;

async function getToken(env) {
  const now = Date.now();
  if (cachedToken && tokenExpiry > now + 60000) return cachedToken;
  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  if (!resp.ok) throw new Error(`Auth HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`Auth code=${data.code} msg=${data.msg}`);
  cachedToken = data.tenant_access_token;
  tokenExpiry = now + 7200 * 1000;
  return cachedToken;
}

function text(fields, key) {
  const v = fields[key];
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(i => (i && i.text) || String(i || "")).filter(Boolean).join(", ");
  return (v && v.text) || "";
}

/** 社团职务为多选字段，统一用 " / " 分隔（与 DeepMei App 快照格式一致）。 */
function positionText(fields) {
  const v = fields["社团职务"];
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(i => (i && i.text) || String(i || "")).filter(Boolean).join(" / ");
  return (v && v.text) || "";
}

/** 入社日期（毫秒时间戳或日期字符串）→ 只取年份（按北京时间，避免跨年偏移）。 */
function joinYear(fields) {
  const raw = text(fields, "入社日期");
  if (!raw) return "";
  const n = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(n)) {
    const d = new Date((n > 10000000000 ? n : n * 1000) + 8 * 3600 * 1000);
    return String(d.getUTCFullYear());
  }
  const m = String(raw).match(/^(\d{4})/);
  return m ? m[1] : "";
}

/** 附件字段 → 第一个可公开访问的 http(s) URL（tmp_url 优先，可规避 403；url 兜底）。 */
function attachmentUrl(fields, key) {
  const v = fields[key];
  if (v == null) return "";
  const arr = Array.isArray(v) ? v : [v];
  for (const item of arr) {
    const u = item && (item.tmp_url || item.url);
    if (typeof u === "string" && /^https?:\/\//i.test(u)) return u;
  }
  return "";
}

/** 头像：仅取「头像」字段第一张（不再回退「个人照片」；个人照片仅作为独立素材单独展示）。 */
function avatarUrl(fields) {
  return attachmentUrl(fields, "头像");
}

/**
 * 把飞书附件 tmp_url 换成浏览器可直接加载的临时下载链接。
 * 飞书的 tmp_url 是 batch_get_tmp_download_url 接口地址，需要带 tenant token 请求后
 * 从 data.tmp_download_urls[0].tmp_download_url 取真实图片地址（与 DeepMei App 逻辑一致）。
 */
async function resolveAvatar(env, fields) {
  let item = null;
  for (const key of ["头像"]) {
    const v = fields[key];
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    for (const it of arr) {
      if (it && typeof it.tmp_url === "string" && /^https?:\/\//i.test(it.tmp_url)) {
        item = it;
        break;
      }
    }
    if (item) break;
  }
  if (item) {
    try {
      const token = await getToken(env);
      const resp = await fetch(item.tmp_url, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        const u = data && data.data && data.data.tmp_download_urls && data.data.tmp_download_urls[0]
          ? data.data.tmp_download_urls[0].tmp_download_url
          : "";
        if (typeof u === "string" && /^https?:\/\//i.test(u)) return u;
      }
    } catch (e) { /* 换取失败时回退 url/tmp_url */ }
  }
  return avatarUrl(fields);
}

/** 按北京时间（Asia/Shanghai, UTC+8）格式化时间，避免 Worker 默认 UTC 显示错误。 */
function formatChinaTime(date, withSeconds) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const base = d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
    " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  return withSeconds ? base + ":" + pad(d.getUTCSeconds()) : base;
}

function buildMember(fields) {
  return {
    name: text(fields, "姓名"),
    alias: text(fields, "别名"),
    idCode: text(fields, "社员编号"),
    generation: text(fields, "年级"),
    className: text(fields, "班级（分班后）"),
    department: text(fields, "社团部门"),
    cardId: text(fields, "社员卡号"),
    readableCode: text(fields, "社员身份编码（认读码）"),
    memberSeq: text(fields, "社员序号"),
    position: positionText(fields),
    joinYear: joinYear(fields),
  };
}

/**
 * 按卡号/识别码/认读码查询单个社员，查不到返回 null。
 * 卡号字段支持 ";" 分隔多张卡：先用 CONTAINS 粗筛，再在 JS 侧按分号做整卡号精确匹配，
 * 避免短卡号作为子串误命中其他成员的长卡号。
 */
async function findMemberByUid(env, uid) {
  const { FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  const token = await getToken(env);
  const n = uid.trim().toUpperCase().replace(/:/g, "");
  const filter = `OR(CurrentValue.[社员卡号].CONTAINS("${n}"),CurrentValue.[社员识别码]="${n}",CurrentValue.[社员身份编码（认读码）]="${n}")`;
  const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?filter=${encodeURIComponent(filter)}&page_size=500`;
  let pageToken = null;

  do {
    let url = base;
    if (pageToken) url += `&page_token=${pageToken}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.code !== 0 || !data.data?.items?.length) return null;

    for (const item of data.data.items) {
      const f = item.fields;
      const cards = (text(f, "社员卡号") || "")
        .split(";").map(s => s.trim().toUpperCase());
      const barcode = text(f, "社员识别码").toUpperCase();
      const readable = text(f, "社员身份编码（认读码）").toUpperCase();
      if (cards.includes(n) || barcode === n || readable === n) {
        return buildMember(f);
      }
    }
    pageToken = data.data?.page_token || null;
  } while (pageToken);

  return null;
}

async function handleMember(request, env) {
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  const query = url.searchParams.get("q");
  if (!uid && !query) return Response.json({ found: false }, { status: 400 });
  if (!env.FEISHU_APP_ID) return Response.json({ found: false }, { status: 500 });

  try {
    // 优先 KV 快照（减少实时访问飞书）
    if (env.SHUMEI_KV) {
      try {
        const snap = await getSnapshot(env);
        const n = uid ? uid.trim().toUpperCase().replace(/:/g, "") : "";
        const q = (query || "").trim();
        for (const item of snap.items) {
          const f = item.fields;
          const name = text(f, "姓名");
          if (!name) continue;
          if (uid) {
            const cards = (text(f, "社员卡号") || "").split(";").map(s => s.trim().toUpperCase());
            const barcode = text(f, "社员识别码").toUpperCase();
            const readable = text(f, "社员身份编码（认读码）").toUpperCase();
            if (cards.includes(n) || barcode === n || readable === n) {
              return Response.json({ found: true, member: buildMember(f) });
            }
          } else {
            const vals = [name, text(f, "别名"), text(f, "社员编号"), text(f, "社员识别码"), text(f, "社员身份编码（认读码）"), text(f, "社员序号")];
            if (vals.indexOf(q) !== -1) return Response.json({ found: true, member: buildMember(f) });
          }
        }
      } catch (e) { /* 快照读取失败，回退实时 */ }
    }
    // 回退：实时飞书（新卡登记等快照未命中场景）
    if (uid) {
      const member = await findMemberByUid(env, uid);
      return member ? Response.json({ found: true, member }) : Response.json({ found: false });
    }

    const token = await getToken(env);
    const q = query.trim();
    const filter = `OR(CurrentValue.[姓名]="${q}",CurrentValue.[别名]="${q}",CurrentValue.[社员编号]="${q}",CurrentValue.[社员识别码]="${q}",CurrentValue.[社员身份编码（认读码）]="${q}",CurrentValue.[社员序号]="${q}")`;
    const apiURL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?filter=${encodeURIComponent(filter)}&page_size=1`;
    const resp = await fetch(apiURL, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return Response.json({ found: false }, { status: 502 });
    const data = await resp.json();
    if (data.code !== 0 || !data.data?.items?.length) return Response.json({ found: false });

    return Response.json({ found: true, member: buildMember(data.data.items[0].fields) });
  } catch (e) {
    return Response.json({ found: false }, { status: 500 });
  }
}

// ============================================================
// [API] 签到提交：写 WPS 多维表 + 发飞书机器人通知
// POST /api/checkin  body: { uid, mode, activity, duration, lat, lng, name }
// ============================================================
async function handleCheckin(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const uid = String(body.uid || "").trim().toUpperCase().replace(/:/g, "");
  if (!uid) return Response.json({ ok: false, error: "missing uid" }, { status: 400 });

  const activity = String(body.activity || "").trim();
  const duration = String(body.duration || "").trim();
  const mode = body.mode === "qr" ? "qr" : "nfc";
  const lat = Number.isFinite(body.lat) ? body.lat : null;
  const lng = Number.isFinite(body.lng) ? body.lng : null;

  // 1. 服务端按 uid 重新查人（不信任前端传的成员信息）；
  //    查不到时（新卡登记场景）用前端兜底姓名。
  let member = null;
  try {
    member = await findMemberByUid(env, uid);
  } catch (e) {
    member = null;
  }
  const name = (member && member.name) || String(body.name || "").trim() || "未知";

  // 2+3. 飞书群通知 + WPS 写入放后台异步执行,不阻塞签到返回(签到秒回)
  if (env.FEISHU_BOT) {
    ctx.waitUntil(
      sendFeishuBot(env, { uid, name, mode, activity, duration, lat, lng, member })
        .catch((e) => console.log("[checkin] Feishu bot send failed:", e.message))
    );
  }
  if (env.WPS_WEBHOOK) {
    ctx.waitUntil(
      pushToWps(env, { uid, name, activity, duration, member })
        .catch((e) => console.log("[checkin] WPS push failed:", e.message))
    );
  }

  return Response.json({ ok: true, member });
}

/** 发飞书机器人 2.0 卡片（从原 index.html sendToFeishuBot 迁移，GPS 由前端传入）。 */
async function sendFeishuBot(env, opts) {
  const { uid, name, mode, activity, duration, lat, lng, member } = opts;
  const memberId = (member && (member.idCode || member.memberSeq)) || "-";
  const dept = (member && member.department) || "";
  const cls = (member && member.className) || "";
  const generation = (member && member.generation) || "";
  const readable = (member && member.readableCode) || uid;
  const act = activity || "";
  const dur = duration || "";
  const modeLabel = mode === "nfc" ? "📱 NFC 刷卡" : "📷 扫码签到";
  const title = act ? "树莓社签到 · " + act : "树莓社签到";

  const timeStr = formatChinaTime(new Date(), false);

  const elements = [];
  elements.push({
    tag: "column_set",
    flex_mode: "bisect",
    columns: [
      { tag: "column", width: "weighted", weight: 1,
        elements: [{ tag: "markdown", content: "📋 活动\n**" + (act || "-") + "**" }] },
      { tag: "column", width: "weighted", weight: 1,
        elements: [{ tag: "markdown", content: "⏱ 时长\n**" + (dur || "0小时") + "**" }] }
    ]
  });
  elements.push({ tag: "hr", margin: "8px 0 0 0" });

  const classLine = [generation, cls].filter(Boolean).join("");
  const subInfo = [dept, classLine].filter(Boolean).join(" · ");
  elements.push({
    tag: "markdown",
    content: "**" + name + "**  " + memberId + (subInfo ? "\n" + subInfo : ""),
    margin: "8px 0 0 0"
  });
  elements.push({ tag: "hr", margin: "8px 0 0 0" });

  const auditLines = ["🔍 识别码：" + readable, "💳 卡号：" + uid];
  if (lat != null && lng != null) {
    auditLines.push("📍 " + lat.toFixed(4) + ", " + lng.toFixed(4) +
      "  [查看地图](https://uri.amap.com/marker?position=" + lng.toFixed(4) + "," + lat.toFixed(4) + ")");
  }
  elements.push({
    tag: "markdown",
    content: auditLines.join("\n"),
    margin: "8px 0 0 0"
  });
  elements.push({
    tag: "button",
    text: { tag: "plain_text", content: "📊 查看签到记录" },
    type: "primary",
    width: "fill",
    size: "medium",
    behaviors: [{ type: "open_url", default_url: "https://szzxshumei.feishu.cn/share/base/view/shrcnkvV0PaPSTcQj7FnDXFw2If" }],
    margin: "8px 0 0 0"
  });

  const card = {
    msg_type: "interactive",
    card: {
      schema: "2.0",
      config: {
        width_mode: "compact",
        summary: { content: name + " · " + (act || modeLabel) }
      },
      header: {
        title: { tag: "plain_text", content: title },
        subtitle: { tag: "plain_text", content: modeLabel + "  |  " + timeStr },
        template: "blue",
        padding: "12px 12px 12px 12px"
      },
      body: {
        direction: "vertical",
        padding: "12px 12px 8px 12px",
        elements
      }
    }
  };

  const resp = await fetch(env.FEISHU_BOT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card)
  });
  return resp.text();
}

/** 写 WPS 多维表（从原 index.html submitToWps 迁移）。 */
async function pushToWps(env, opts) {
  const timeStr = formatChinaTime(new Date(), true);

  const payload = {
    cardUid: opts.uid,
    timestamp: timeStr,
    userName: opts.name || "",
    department: (opts.member && opts.member.department) || "",
    className: (opts.member && opts.member.className) || "",
    activity: opts.activity || "",
    duration: opts.duration || ""
  };

  const resp = await fetch(env.WPS_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return resp.status;
}

async function handleMembers(env) {
  if (!env.SHUMEI_KV) return Response.json({ error: "Missing KV binding" }, { status: 500 });
  if (!env.FEISHU_APP_ID) return Response.json({ error: "Missing env vars" }, { status: 500 });
  try {
    const snap = await getSnapshot(env);
    const cardMap = {};
    const barcodeMap = {};
    const infoMap = {};
    for (const item of snap.items) {
      const f = item.fields;
      const name = text(f, "姓名");
      if (!name) continue;
      const cid = text(f, "社员卡号");
      const bid = text(f, "社员识别码");
      const rid = text(f, "社员身份编码（认读码）");
      if (cid) {
        cid.split(";").forEach(function(id) {
          var trimmed = id.trim();
          if (trimmed) cardMap[trimmed] = name;
        });
      }
      if (bid) barcodeMap[bid] = name;
      if (rid) barcodeMap[rid] = name;
      if (!infoMap[name]) {
        infoMap[name] = {
          idCode: text(f, "社员编号"),
          dept: text(f, "社团部门"),
          cls: text(f, "班级（分班后）"),
          generation: text(f, "年级"),
          readable: rid,
        };
      }
    }
    return Response.json({ updatedAt: snap.updatedAt, cardMap, barcodeMap, infoMap }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ============================================================
// [KV] 社员快照缓存：定时同步飞书 → KV，读接口优先走 KV
// 减少对飞书 Bitable 的实时访问（飞书慢/有配额限制）
// ============================================================
const KV_KEY = "members_full";
const ACTIVITY_TABLE_ID = "tbl30yargX7IZ1kc";
const ACTIVITY_DETAIL_TABLE_ID = "tbl5Gr3qoPBatTmt";
const ACTIVITY_KV_KEY = "activity_records_v3";
// 活动项目完整快照（含封面/相册附件、介绍等展示字段）——仅服务活动页接口，独立于上述缓存
const ACTIVITY_PROJECTS_KV_KEY = "activity_projects_v1";
// 社员证明文件快照（文件资料管理表「社员证明」类记录；惰性 60min，不参与 cron）[2026-09-06]
const FILE_TABLE_ID = "tblO5pPurRqVPMR5";
const FILE_KV_KEY = "file_proofs_v1";
const FILE_TTL = 60 * 60 * 1000;

/** 从飞书分页拉取全量原始记录（含 record_id）。 */
async function fetchFullFromFeishu(env) {
  const token = await getToken(env);
  const { FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  const items = [];
  let pageToken = null;

  do {
    let url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`code=${data.code}`);
    for (const item of data.data?.items || []) items.push({ recordId: item.record_id, fields: item.fields });
    pageToken = data.data?.page_token || null;
  } while (pageToken);

  return { updatedAt: Date.now(), items };
}

/** 读 KV 快照；未命中或为空时实时拉飞书并写回 KV（首次/被清时的兜底）。 */
async function getSnapshot(env) {
  try {
    const cached = await env.SHUMEI_KV.get(KV_KEY, "json");
    if (cached && Array.isArray(cached.items) && cached.items.length) return cached;
  } catch (e) { /* KV 不可用时走实时 */ }
  const fresh = await fetchFullFromFeishu(env);
  try { await env.SHUMEI_KV.put(KV_KEY, JSON.stringify(fresh)); } catch (e) {}
  return fresh;
}

/** 拉取一张飞书多维表的全量记录。 */
async function fetchTableRecords(env, tableId) {
  const token = await getToken(env);
  const items = [];
  let pageToken = null;
  do {
    let url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${env.FEISHU_APP_TOKEN}/tables/${tableId}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data.code !== 0) throw new Error(`code=${data.code}`);
    for (const item of data.data?.items || []) items.push({ recordId: item.record_id, fields: item.fields });
    pageToken = data.data?.page_token || null;
  } while (pageToken);
  return items;
}

/** 双向关联字段 → 关联的 record_id 列表。 */
function linkIds(v) {
  const ids = [];
  for (const item of Array.isArray(v) ? v : []) {
    if (item && Array.isArray(item.record_ids)) ids.push(...item.record_ids);
  }
  return ids;
}

/** 数字字段（保留小数）。 */
function numVal(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 日期字段 → YYYY-MM-DD（按北京时间）。 */
function dateText(v) {
  if (typeof v === "string") {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    const d = new Date((n > 10000000000 ? n : n * 1000) + 8 * 3600 * 1000);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return "";
}

// ============================================================
// [KV] 社员证明文件快照（2026-09-06 新增）
// 数据：文件资料管理表「内容类型=社员证明」记录（学期制盖章扫描 PDF，如
//       「树莓社社团证明-2024-2025学年第1学期（2025年1月）」）。
// 判定：不解析文件名，直接用「发布时间」与社员「入社日期」比较（P >= J 即印发时已在社）。
// 模式与 getSnapshot 一致：KV 优先（60min 惰性）→ 未命中实时拉取写回；不参与 cron。
// ============================================================
async function getFileSnapshot(env) {
  try {
    const cached = await env.SHUMEI_KV.get(FILE_KV_KEY, "json");
    if (cached && Date.now() - (cached.updatedAt || 0) < FILE_TTL && Array.isArray(cached.items)) return cached;
  } catch (e) { /* KV 不可用时走实时 */ }
  const rows = await fetchTableRecords(env, FILE_TABLE_ID);
  const items = [];
  for (const r of rows) {
    const f = r.fields || {};
    const types = f["内容类型"];
    const isProof = Array.isArray(types)
      ? types.some((t) => String((t && (t.text !== undefined ? t.text : t)) || "") === "社员证明")
      : String(types || "") === "社员证明";
    if (!isProof) continue;
    const title = text(f, "资料名称");
    const publishedAt = dateText(f["发布时间"]);   // YYYY-MM-DD；无发布时间无法判资格，跳过
    if (!publishedAt) continue;
    const att = f["文件【首选】"];
    const first = Array.isArray(att) ? att[0] : att;
    if (!first || typeof first.file_token !== "string" || !first.file_token) continue;
    items.push({
      title,
      publishedAt,
      file: {
        fileToken: first.file_token,
        name: typeof first.name === "string" ? first.name : (title + ".pdf"),
        size: first.size || 0,
        type: first.type || "application/pdf",
        tmp_url: typeof first.tmp_url === "string" ? first.tmp_url : "",
        url: typeof first.url === "string" ? first.url : "",
      },
    });
  }
  items.sort((x, y) => (x.publishedAt < y.publishedAt ? -1 : x.publishedAt > y.publishedAt ? 1 : 0));
  const snap = { updatedAt: Date.now(), items };
  try { await env.SHUMEI_KV.put(FILE_KV_KEY, JSON.stringify(snap)); } catch (e) { /* 写缓存失败可忽略 */ }
  return snap;
}

/**
 * 构建「社员 → 活动参与记录」快照：
 * 活动参与明细表按 record_id join 活动项目表/社员表，
 * 输出前端可直接显示的扁平结构（避免按名称匹配的脏数据问题）。
 */
async function buildActivitySnapshot(env) {
  const memberSnap = await getSnapshot(env);
  const memberCodeByRecord = {};
  for (const it of memberSnap.items) {
    const code = text(it.fields, "社员识别码").trim().toUpperCase();
    if (it.recordId && code) memberCodeByRecord[it.recordId] = code;
  }

  const [detailRows, activityRows] = await Promise.all([
    fetchTableRecords(env, ACTIVITY_DETAIL_TABLE_ID),
    fetchTableRecords(env, ACTIVITY_TABLE_ID),
  ]);

  const activityByRecord = {};
  for (const a of activityRows) {
    activityByRecord[a.recordId] = {
      name: text(a.fields, "项目名称").trim(),
      type: text(a.fields, "项目类型"),
      date: dateText(a.fields["主要活动日期"]),
    };
  }

  const items = [];
  for (const d of detailRows) {
    const f = d.fields;
    const memberIds = linkIds(f["社员"]);
    const actIds = linkIds(f["活动项目"]);

    const actId = actIds[0] || "";
    const act = activityByRecord[actId] || {};
    const activityHours = numVal(f["参与时长（小时）"]);
    const rawVol = f["志愿服务时长"];
    const volunteerHours = rawVol !== undefined && rawVol !== null && rawVol !== "" ? numVal(rawVol) : 0;

    // 一行关联多个社员时按人数展开（每人同时长，口径：参与时长按"每人时长"理解）
    for (const rid of memberIds) {
      const memberCode = memberCodeByRecord[rid] || "";
      if (!memberCode) continue;
      items.push({
        memberCode,
        activityId: actId,
        activityName: act.name,
        activityType: act.type,
        date: act.date,
        role: text(f, "参与角色"),
        activityHours,
        volunteerHours,
      });
    }
  }

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { updatedAt: Date.now(), items };
}

/** 读活动记录快照；未命中时实时构建并写回 KV。 */
async function getActivitySnapshot(env) {
  try {
    const cached = await env.SHUMEI_KV.get(ACTIVITY_KV_KEY, "json");
    if (cached && Array.isArray(cached.items) && cached.updatedAt) return cached;
  } catch (e) { /* KV 不可用时走实时 */ }
  const fresh = await buildActivitySnapshot(env);
  try { await env.SHUMEI_KV.put(ACTIVITY_KV_KEY, JSON.stringify(fresh)); } catch (e) {}
  return fresh;
}

// ============================================================
// [KV] 活动项目完整快照（活动页专用，2026-09-03 新增）
// 目的：现有 buildActivitySnapshot 拉项目表后只用名称/类型/日期 3 个字段，
//       封面/相册/介绍等展示字段被丢弃。此快照把项目表完整字段留一份，
//       供新增的活动列表/详情/照片接口使用。
// 模式与 getSnapshot 完全一致（KV 优先 → 未命中实时拉写回），不碰现有逻辑。
// ============================================================

/** 附件字段 → 附件对象数组（保留取图所需字段；生产 REST 返回 tmp_url/url 时带上）。
 *  仅保留图片附件（按文件名扩展名白名单）：「活动照片、活动成果和海报」列混有
 *  文档/表格/PPT/音视频（2026-09-03 审计：184 活动中 11 个混入 14 个非图片文件），
 *  这些不是照片墙内容，也会污染封面兜底与照片计数，一律不进快照。 */
const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|heic|avif|jfif)$/i;
function attachmentsOf(fields, key) {
  const v = fields ? fields[key] : null;
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  const out = [];
  for (const it of arr) {
    if (!it || typeof it.file_token !== "string" || !it.file_token) continue;
    const name = typeof it.name === "string" ? it.name : "";
    if (!name || !IMG_EXT_RE.test(name)) continue;
    out.push({
      token: it.file_token,
      name,
      tmp_url: typeof it.tmp_url === "string" ? it.tmp_url : "",
      url: typeof it.url === "string" ? it.url : "",
    });
  }
  return out;
}

/** 项目表行 → 活动项目列表（完整展示字段）。封面优先，无封面用相册首图兜底。 */
async function buildActivityProjectSnapshot(env) {
  const rows = await fetchTableRecords(env, ACTIVITY_TABLE_ID);
  const items = [];
  for (const a of rows) {
    const f = a.fields || {};
    // 注意：字段名与飞书表头逐字符一致——「封面图片（1张）」全角括号且"张"前无空格
    const name = text(f, "项目名称").trim();
    if (!name) continue;
    const coverAtt = attachmentsOf(f, "封面图片（1张）");
    const photos = attachmentsOf(f, "活动照片、活动成果和海报");
    items.push({
      id: a.recordId,
      name,
      type: text(f, "项目类型"),
      date: dateText(f["主要活动日期"]),
      place: text(f, "活动地点/形式"),
      intro: text(f, "项目介绍"),
      result: text(f, "活动成果"),
      record: text(f, "活动记录"),
      hoursPer: numVal(f["活动时长（人均）"]),
      isVolunteer: f["计入志愿时长"] === true,
      cover: coverAtt[0] || photos[0] || null,
      photos,
    });
  }
  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { updatedAt: Date.now(), items };
}

/** 读活动项目快照；未命中时实时拉取并写回 KV（与 getSnapshot 同模式）。 */
async function getActivityProjectSnapshot(env) {
  try {
    const cached = await env.SHUMEI_KV.get(ACTIVITY_PROJECTS_KV_KEY, "json");
    if (cached && Array.isArray(cached.items) && cached.items.length) return cached;
  } catch (e) { /* KV 不可用时走实时 */ }
  const fresh = await buildActivityProjectSnapshot(env);
  try { await env.SHUMEI_KV.put(ACTIVITY_PROJECTS_KV_KEY, JSON.stringify(fresh)); } catch (e) {}
  return fresh;
}

/** 按活动聚合统计（参与人次 / 总时长 / 志愿时长），基于现有 activity_records_v3 明细。 */
function aggregateActivityStats(detailItems) {
  const byAct = {};
  for (const r of detailItems) {
    if (!r.activityId) continue;
    const s = byAct[r.activityId] || (byAct[r.activityId] = { people: 0, totalHours: 0, volunteerHours: 0 });
    s.people += 1;
    s.totalHours += r.activityHours || 0;
    s.volunteerHours += r.volunteerHours || 0;
  }
  return byAct;
}

/** 保留 1 位小数，去掉浮点尾巴（210.00000000000003 → 210）。 */
function round1(n) { return Math.round(n * 10) / 10; }


// ============================================================
// [API] 全量成员快照：优先 KV 命中，返回最新快照
// 供 DeepMei App 本地缓存 24h。
// ============================================================
async function handleMembersFull(env) {
  if (!env.SHUMEI_KV) return Response.json({ error: "Missing KV binding" }, { status: 500 });
  if (!env.FEISHU_APP_ID) return Response.json({ error: "Missing env vars" }, { status: 500 });
  try {
    const snap = await getSnapshot(env);
    return Response.json({ updatedAt: snap.updatedAt, items: snap.items }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ============================================================
// [API] 单人档案：按社员识别码返回脱敏完整档案（公开给网页）
// GET /api/members/detail?code=SM201809A00100201
// 只输出展示字段，不含 登录密码/QQ/电话/身份证/卡号 等敏感数据；
// 勾选「禁止查询」复选框的成员返回 found:false（签到查人 / App 快照 / 头像代理不受影响）；
// 有附件时输出 avatarProxy（/api/avatar 代理直链）并跳过飞书换取；
// 头像仅取自「头像」字段，不再用「个人照片」兜底；无头像时返回空（由前端占位处理）。
// /api/members/full 保持不变（App 等其它服务继续使用）。
// ============================================================
function num(fields, key) {
  const v = fields[key];
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

/** 附件 file_token（仅「头像」字段取第一个；用于构建代理直链）。 */
function avatarTokenOf(fields) {
  for (const key of ["头像"]) {
    const v = fields[key];
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    for (const item of arr) {
      if (item && typeof item.file_token === "string" && item.file_token) return item.file_token;
    }
  }
  return "";
}

/**
 * 「禁止查询」复选框（飞书多维表字段，勾选 = true）：
 * 勾选后仅 detail 档案查询返回未找到；签到查人 / App 快照 / 头像代理均不受影响。
 * 未勾选时字段值可能为 false 或整列缺失，一律视为可查。
 */
function isBlocked(fields) {
  const v = fields ? fields["禁止查询"] : null;
  return v === true || v === "true" || v === 1;
}

/** 单人档案（脱敏白名单）。 */
function buildDetailMember(fields) {
  return {
    id: text(fields, "社员识别码"),
    name: text(fields, "姓名"),
    alias: text(fields, "别名"),
    gender: text(fields, "性别"),
    grade: text(fields, "年级"),
    dept: text(fields, "社团部门"),
    rank: text(fields, "社员评级"),
    clazz: text(fields, "班级（分班后）"),
    role: text(fields, "社团职务"),
    honor: text(fields, "其他职务或荣誉"),
    bio: text(fields, "详细介绍"),
    grad: text(fields, "升学去向"),
    activityCount: num(fields, "参与活动次数"),
    activityHours: num(fields, "参与活动时长"),
    totalHours: num(fields, "志愿服务时长"),
    joinYear: joinYear(fields),
    joinDate: dateText(fields["入社日期"]),   // YYYY-MM-DD（北京时区）；空串 = 未登记（证明资格判定用）[2026-09-06]
    seq: text(fields, "社员编号"),
    avatar: avatarUrl(fields),
    avatarToken: avatarTokenOf(fields),
  };
}

async function handleMemberDetail(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const CORS = { "Access-Control-Allow-Origin": "*" };
  if (!code) return Response.json({ found: false, error: "missing code" }, { status: 400, headers: CORS });
  if (!env.SHUMEI_KV || !env.FEISHU_APP_ID) return Response.json({ found: false }, { status: 500, headers: CORS });
  const n = code.trim().toUpperCase().replace(/:/g, "");
  // 边缘缓存：每个识别码一条（数据为公开展示内容，5 分钟 TTL）
  const cacheKey = new Request(`https://${url.host}/_cache/detail/${n}`);
  try {
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const snap = await getSnapshot(env);
    for (const item of snap.items) {
      if (text(item.fields, "社员识别码").toUpperCase() === n) {
        if (isBlocked(item.fields)) return Response.json({ found: false }, { headers: CORS });
        const member = buildDetailMember(item.fields);
        // 方案 B：有 file_token 时输出 avatarProxy 代理直链并跳过飞书换取
        //（avatar 置空，避免每次冷访问 1~2s 的 authcode 换取）；
        // 无附件（历史成员）时保留旧换取兜底。
        if (member.avatarToken) {
          member.avatarProxy = `https://${url.host}/api/avatar?token=${encodeURIComponent(member.avatarToken)}`;
          member.avatar = "";
        } else {
          member.avatar = await resolveAvatar(env, item.fields);
          member.avatarProxy = "";
        }
        delete member.avatarToken;
        try {
          const actSnap = await getActivitySnapshot(env);
          member.activities = actSnap.items.filter((i) => i.memberCode === n);
        } catch (e) {
          member.activities = [];
        }
        const resp = Response.json({ found: true, member }, {
          headers: { "Cache-Control": "public, max-age=300", ...CORS },
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
      }
    }
    return Response.json({ found: false }, { headers: CORS });
  } catch (e) {
    return Response.json({ found: false, error: e.message }, { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 社员可下载的证明清单（2026-09-06 新增）
// GET /api/member/proofs?code=SM…
// 判定：文件「发布时间」(P=YYYYMMDD) >= 社员「入社日期」(J=YYYYMMDD) 即印发时已在社 → 可下载；
//       入社日期未登记时返回全部（配合前端提示补录）。只读，与 detail 同策略（禁止查询/未找到）。
// ============================================================
async function handleMemberProofs(request, env, ctx) {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") || "").trim().toUpperCase().replace(/:/g, "");
  const CORS = { "Access-Control-Allow-Origin": "*" };
  if (!code) return Response.json({ found: false, error: "missing code" }, { status: 400, headers: CORS });
  if (!env.SHUMEI_KV || !env.FEISHU_APP_ID) return Response.json({ found: false }, { status: 500, headers: CORS });
  try {
    const snap = await getSnapshot(env);            // 社员快照（既有）
    let m = null;
    for (const it of snap.items) {
      if (text(it.fields, "社员识别码").toUpperCase() === code) { m = it.fields; break; }
    }
    if (!m || isBlocked(m)) return Response.json({ found: false }, { headers: CORS });
    const joinDate = dateText(m["入社日期"]);       // YYYY-MM-DD；空串 → 不限（兜底）
    const J = joinDate ? Number(joinDate.replace(/-/g, "")) : 0;
    const fSnap = await getFileSnapshot(env);
    const proofs = [];
    for (const p of fSnap.items) {
      if (J && Number(p.publishedAt.replace(/-/g, "")) < J) continue;   // 印发早于入社 → 跳过
      proofs.push({
        title: p.title,
        publishedAt: p.publishedAt,
        files: [{ name: p.file.name, size: p.file.size, fileToken: p.file.fileToken }],
      });
    }
    return Response.json({
      found: true,
      member: { code, name: text(m, "姓名"), joinDate },
      proofs,
    }, { headers: CORS });
  } catch (e) {
    return Response.json({ found: false, error: e.message }, { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 社员证明附件代理（2026-09-06 新增）
// GET /api/file?token=<file_token> → 原样透传（PDF 等任意类型，不走 cf.image 缩放）
// 白名单：token 必须出现在证明文件快照中（防止任意读取）；L1 边缘缓存 7 天，不写 KV
// 取附件机制与 /api/photo 一致（tmp_url 换直链 → url 带鉴权兜底）
// ============================================================
async function handleFile(request, env, ctx) {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") || "").trim();
  const CORS = { "Access-Control-Allow-Origin": "*" };
  if (!token) return new Response("missing token", { status: 400, headers: CORS });
  if (!env.SHUMEI_KV || !env.FEISHU_APP_ID) return new Response("missing env", { status: 500, headers: CORS });
  const cacheKey = new Request(`https://${url.host}/_cache/file/${token}`);
  try {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    const fSnap = await getFileSnapshot(env);
    const att = fSnap.items.map((p) => p.file).find((f) => f.fileToken === token);
    if (!att) return new Response("not found", { status: 404, headers: CORS });
    const resolved = await resolvePhotoUrl(env, att);
    if (!resolved) return new Response("file unavailable", { status: 502, headers: CORS });
    const feishuToken = await getToken(env);
    const dl = await fetch(resolved.url, {
      headers: resolved.needsAuth ? { Authorization: `Bearer ${feishuToken}` } : undefined,
    });
    if (!dl.ok) return new Response("file unavailable", { status: 502, headers: CORS });
    const bytes = await dl.arrayBuffer();
    const resp = new Response(bytes, {
      headers: {
        "Content-Type": att.type || "application/pdf",
        "Cache-Control": "public, max-age=604800",
        ...CORS,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response("error", { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 头像代理：file_token → 图片字节（边缘缓存 1 天 + KV 永久）
// GET /api/avatar?token=<file_token>
// 链路：L1 Cache API → L2 KV（永久，飞书删图仍可访问）→ 飞书换取并回写双层
// 仅接受成员快照中存在的 file_token（白名单校验，防止任意读取）
// ============================================================
async function handleAvatar(request, env, ctx) {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") || "").trim();
  const CORS = { "Access-Control-Allow-Origin": "*" };
  if (!token) return Response.json({ error: "missing token" }, { status: 400, headers: CORS });
  if (!env.SHUMEI_KV || !env.FEISHU_APP_ID) return Response.json({ error: "missing env" }, { status: 500, headers: CORS });
  const cacheKey = new Request(`https://${url.host}/_cache/avatar/${token}`);
  try {
    const cache = caches.default;
    // L1 边缘缓存（TTL 1 天）
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    // L2 KV 永久缓存（0 = 不过期）
    const kvBytes = await env.SHUMEI_KV.get(`avatar_img_${token}`, "arrayBuffer");
    if (kvBytes) {
      const resp = new Response(kvBytes, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", ...CORS },
      });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }
    // 白名单校验：token 必须存在于成员快照附件中
    const snap = await getSnapshot(env);
    let attachment = null;
    for (const it of snap.items) {
      const f = it.fields || {};
      for (const key of ["头像", "个人照片"]) {
        const v = f[key];
        if (v == null) continue;
        const arr = Array.isArray(v) ? v : [v];
        for (const item of arr) {
          if (item && item.file_token === token) { attachment = item; break; }
        }
        if (attachment) break;
      }
      if (attachment) break;
    }
    if (!attachment) return new Response("not found", { status: 404, headers: CORS });
    // 取图：优先 tmp_url 换 authcode 直链，其次 url 带鉴权直取
    let bytes = null;
    let type = attachment.type || "image/jpeg";
    const feishuToken = await getToken(env);
    if (typeof attachment.tmp_url === "string" && /^https?:\/\//i.test(attachment.tmp_url)) {
      try {
        const resp = await fetch(attachment.tmp_url, {
          headers: { Authorization: `Bearer ${feishuToken}`, "Content-Type": "application/json" },
        });
        if (resp.ok) {
          const data = await resp.json();
          const u = data && data.data && data.data.tmp_download_urls && data.data.tmp_download_urls[0]
            ? data.data.tmp_download_urls[0].tmp_download_url : "";
          if (typeof u === "string" && /^https?:\/\//i.test(u)) {
            const img = await fetch(u);
            if (img.ok) bytes = await img.arrayBuffer();
          }
        }
      } catch (e) { /* 兜底到 url */ }
    }
    if (!bytes && typeof attachment.url === "string" && /^https?:\/\//i.test(attachment.url)) {
      try {
        const img = await fetch(attachment.url, { headers: { Authorization: `Bearer ${feishuToken}` } });
        if (img.ok) {
          bytes = await img.arrayBuffer();
          type = img.headers.get("content-type") || type;
        }
      } catch (e) { /* 失败 */ }
    }
    if (!bytes) return new Response("image unavailable", { status: 502, headers: CORS });
    // 回写 L1（1 天）+ L2（永久）
    const resp = new Response(bytes, {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400", ...CORS },
    });
    ctx.waitUntil(Promise.all([
      cache.put(cacheKey, resp.clone()),
      env.SHUMEI_KV.put(`avatar_img_${token}`, bytes),
    ]));
    return resp;
  } catch (e) {
    return new Response("error", { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 活动列表（2026-09-03 新增，独立于现有接口）
// GET /api/activities?year=2026|early&type=<类型>&q=<关键词>&limit=20&offset=0
//   year  4 位年份，或 "early" = 2023 年及更早；limit 1~200 默认 20
// 数据源：项目完整快照 activity_projects_v1 + 现有 activity_records_v3 统计
// 边缘缓存 5 分钟。
// ============================================================
async function handleActivities(request, env, ctx) {
  const url = new URL(request.url);
  const CORS = { "Access-Control-Allow-Origin": "*" };
  const cacheKey = new Request(`https://${url.host}/_cache/activities${url.search}`);
  try {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const [projSnap, actSnap] = await Promise.all([
      getActivityProjectSnapshot(env),
      getActivitySnapshot(env),
    ]);
    const statByAct = aggregateActivityStats(actSnap.items);

    const year = (url.searchParams.get("year") || "").trim();
    const type = (url.searchParams.get("type") || "").trim();
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();

    let list = projSnap.items;
    if (year === "early") {
      list = list.filter((i) => { const y = Number((i.date || "").slice(0, 4)); return y > 0 && y <= 2023; });
    } else if (/^\d{4}$/.test(year)) {
      list = list.filter((i) => (i.date || "").slice(0, 4) === year);
    }
    if (type) list = list.filter((i) => i.type === type);
    if (q) list = list.filter((i) => i.name.toLowerCase().indexOf(q) >= 0 || (i.place || "").toLowerCase().indexOf(q) >= 0);

    const total = list.length;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 1), 200);
    const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);
    const host = url.host;

    const items = list.slice(offset, offset + limit).map((i) => {
      const st = statByAct[i.id] || { people: 0, totalHours: 0, volunteerHours: 0 };
      const photos = i.photos || [];
      // 封面若取自相册首图兜底，则已计入 photos，避免重复计数
      const separate = i.cover && !photos.some((p) => p.token === i.cover.token);
      return {
        id: i.id,
        name: i.name,
        type: i.type,
        date: i.date,
        place: i.place,
        hoursPer: i.hoursPer,
        isVolunteer: i.isVolunteer,
        photoCount: photos.length + (separate ? 1 : 0),
        people: st.people,
        cover: i.cover ? `https://${host}/api/photo?token=${encodeURIComponent(i.cover.token)}&w=400` : "",
      };
    });

    // 筛选项按全量统计，不受当前筛选影响
    const typeSet = {};
    const yearSet = {};
    for (const i of projSnap.items) {
      if (i.type) typeSet[i.type] = (typeSet[i.type] || 0) + 1;
      const y = (i.date || "").slice(0, 4);
      if (/^\d{4}$/.test(y)) yearSet[y] = (yearSet[y] || 0) + 1;
    }

    const resp = Response.json({
      updatedAt: projSnap.updatedAt,
      total, offset, limit, items,
      facets: {
        types: Object.keys(typeSet).sort().map((t) => ({ type: t, count: typeSet[t] })),
        years: Object.keys(yearSet).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).map((y) => ({ year: y, count: yearSet[y] })),
      },
    }, { headers: { "Cache-Control": "public, max-age=300", ...CORS } });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return Response.json({ error: e.message, items: [] }, { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 活动详情（2026-09-03 新增）
// GET /api/activities/detail?id=<record_id>
// 只输出统计数字（参与人次/总时长/志愿时长）与照片，**不输出参与人名单**
// 边缘缓存 5 分钟。
// ============================================================
async function handleActivityDetail(request, env, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const CORS = { "Access-Control-Allow-Origin": "*" };
  if (!id) return Response.json({ found: false, error: "missing id" }, { status: 400, headers: CORS });
  const cacheKey = new Request(`https://${url.host}/_cache/activity/${id}`);
  try {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const projSnap = await getActivityProjectSnapshot(env);
    const item = projSnap.items.find((i) => i.id === id);
    if (!item) return Response.json({ found: false }, { headers: CORS });

    const actSnap = await getActivitySnapshot(env);
    let people = 0, totalHours = 0, volunteerHours = 0;
    for (const r of actSnap.items) {
      if (r.activityId !== id) continue;
      people += 1;
      totalHours += r.activityHours || 0;
      volunteerHours += r.volunteerHours || 0;
    }

    const host = url.host;
    const seen = {};
    const photos = [];
    for (const p of [item.cover].concat(item.photos || [])) {
      if (!p || !p.token || seen[p.token]) continue;
      seen[p.token] = 1;
      const t = encodeURIComponent(p.token);
      photos.push({
        token: p.token,
        name: p.name,
        thumb: `https://${host}/api/photo?token=${t}&w=400`,
        full: `https://${host}/api/photo?token=${t}&w=1200`,
      });
    }

    const activity = {
      id: item.id,
      name: item.name,
      type: item.type,
      date: item.date,
      place: item.place,
      intro: item.intro,
      result: item.result,
      record: item.record,
      hoursPer: item.hoursPer,
      isVolunteer: item.isVolunteer,
      photos,
      stats: { people, totalHours: round1(totalHours), volunteerHours: round1(volunteerHours) },
    };
    const resp = Response.json({ found: true, activity }, {
      headers: { "Cache-Control": "public, max-age=300", ...CORS },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return Response.json({ found: false, error: e.message }, { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 活动照片代理（2026-09-03 新增）
// GET /api/photo?token=<file_token>&w=400&fmt=jpeg
//   白名单：token 必须出现在活动项目快照的封面/相册里，防止任意读取
//   取图机制与 /api/avatar 一致（tmp_url 换直链 → url 兜底）
//   缓存：仅 L1 边缘 7 天，**不写 KV**（250 张原图共约 738MB，不适合 KV）
//   w 白名单 [200,400,800,1200]；cf.image 缩放未启用时自动降级原图直出
// ============================================================
const PHOTO_WIDTHS = [200, 400, 800, 1200];

/** 附件对象 → 可直取的下载 URL（与 /api/avatar 同一机制）。 */
async function resolvePhotoUrl(env, att) {
  const feishuToken = await getToken(env);
  if (typeof att.tmp_url === "string" && /^https?:\/\//i.test(att.tmp_url)) {
    try {
      const resp = await fetch(att.tmp_url, {
        headers: { Authorization: `Bearer ${feishuToken}`, "Content-Type": "application/json" },
      });
      if (resp.ok) {
        const data = await resp.json();
        const u = data && data.data && data.data.tmp_download_urls && data.data.tmp_download_urls[0]
          ? data.data.tmp_download_urls[0].tmp_download_url : "";
        if (typeof u === "string" && /^https?:\/\//i.test(u)) return { url: u, needsAuth: false };
      }
    } catch (e) { /* 兜底到 url */ }
  }
  if (typeof att.url === "string" && /^https?:\/\//i.test(att.url)) return { url: att.url, needsAuth: true };
  return null;
}

async function handlePhoto(request, env, ctx) {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") || "").trim();
  const CORS = { "Access-Control-Allow-Origin": "*" };
  if (!token) return new Response("missing token", { status: 400, headers: CORS });
  if (!env.SHUMEI_KV || !env.FEISHU_APP_ID) return new Response("missing env", { status: 500, headers: CORS });

  const wRaw = Number(url.searchParams.get("w"));
  const w = PHOTO_WIDTHS.indexOf(wRaw) >= 0 ? wRaw : 800;
  const fmt = (url.searchParams.get("fmt") || "").toLowerCase() === "webp" ? "webp" : "jpeg";

  const cacheKey = new Request(`https://${url.host}/_cache/photo/${token}/${w}.${fmt}`);
  try {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const snap = await getActivityProjectSnapshot(env);
    let att = null;
    for (const it of snap.items) {
      if (it.cover && it.cover.token === token) { att = it.cover; break; }
      const m = (it.photos || []).find((p) => p.token === token);
      if (m) { att = m; break; }
    }
    if (!att) return new Response("not found", { status: 404, headers: CORS });

    const resolved = await resolvePhotoUrl(env, att);
    if (!resolved) return new Response("image unavailable", { status: 502, headers: CORS });
    const feishuToken = await getToken(env);
    const img = await fetch(resolved.url, {
      headers: resolved.needsAuth ? { Authorization: `Bearer ${feishuToken}` } : undefined,
      cf: { image: { width: w, quality: 80, format: fmt, fit: "scale-down", metadata: "none" } },
    });
    if (!img.ok) return new Response("image unavailable", { status: 502, headers: CORS });

    const resp = new Response(await img.arrayBuffer(), {
      headers: {
        "Content-Type": `image/${fmt}`,
        "Cache-Control": "public, max-age=604800",
        ...CORS,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return new Response("error", { status: 500, headers: CORS });
  }
}

// ============================================================
// [API] 触发刷新：拉飞书全量 → 写 KV（供飞书自动化「发送 HTTP 请求」调用）
// POST /api/refresh  鉴权：Authorization: Bearer <REFRESH_TOKEN> 或 ?token=
// 带 30 秒冷却，防止自动化频繁触发打爆飞书。（冷却为尽力而为，跨实例不严格一致）
// ============================================================
const REFRESH_COOLDOWN_MS = 30 * 1000;
const LAST_REFRESH_KEY = "last_refresh_at";

async function handleRefresh(request, env) {
  const url = new URL(request.url);
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const token = auth || url.searchParams.get("token") || "";
  if (!env.REFRESH_TOKEN || token !== env.REFRESH_TOKEN) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // 冷却用 KV 存时间戳（跨实例一致，防止自动化频繁触发打爆飞书）
  const now = Date.now();
  const last = Number((await env.SHUMEI_KV.get(LAST_REFRESH_KEY)) || 0);
  if (now - last < REFRESH_COOLDOWN_MS) {
    return Response.json({ ok: false, error: "cooldown" }, { status: 429 });
  }
  try {
    const snap = await fetchFullFromFeishu(env);
    await env.SHUMEI_KV.put(KV_KEY, JSON.stringify(snap));
    const actSnap = await buildActivitySnapshot(env);
    await env.SHUMEI_KV.put(ACTIVITY_KV_KEY, JSON.stringify(actSnap));
    // 追加：同步刷新活动项目完整快照（活动页专用）
    const projSnap = await buildActivityProjectSnapshot(env);
    await env.SHUMEI_KV.put(ACTIVITY_PROJECTS_KV_KEY, JSON.stringify(projSnap));
    await env.SHUMEI_KV.put(LAST_REFRESH_KEY, String(now));
    return Response.json({
      ok: true,
      updatedAt: snap.updatedAt,
      items: snap.items.length,
      activityItems: actSnap.items.length,
      activityProjects: projSnap.items.length,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/members") return handleMembers(env);
    if (url.pathname === "/api/members/full") return handleMembersFull(env);
    if (url.pathname === "/api/members/detail") return handleMemberDetail(request, env, ctx);
    if (url.pathname === "/api/member/proofs") return handleMemberProofs(request, env, ctx);
    if (url.pathname === "/api/file") return handleFile(request, env, ctx);
    if (url.pathname === "/api/avatar") return handleAvatar(request, env, ctx);
    if (url.pathname === "/api/member") return handleMember(request, env);
    if (url.pathname === "/api/activities") return handleActivities(request, env, ctx);
    if (url.pathname === "/api/activities/detail") return handleActivityDetail(request, env, ctx);
    if (url.pathname === "/api/photo") return handlePhoto(request, env, ctx);
    if (url.pathname === "/api/refresh" && request.method === "POST") return handleRefresh(request, env);
    if (url.pathname === "/api/checkin" && request.method === "POST") return handleCheckin(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  // 定时同步：飞书 → KV（减少实时访问飞书）
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const snap = await fetchFullFromFeishu(env);
        await env.SHUMEI_KV.put(KV_KEY, JSON.stringify(snap));
        console.log("[cron] members snapshot refreshed at", snap.updatedAt);
      } catch (e) {
        console.log("[cron] refresh failed:", e.message);
      }
      try {
        const actSnap = await buildActivitySnapshot(env);
        await env.SHUMEI_KV.put(ACTIVITY_KV_KEY, JSON.stringify(actSnap));
        console.log("[cron] activity snapshot refreshed at", actSnap.updatedAt);
      } catch (e) {
        console.log("[cron] activity refresh failed:", e.message);
      }
      // 追加：同步刷新活动项目完整快照（活动页专用；未启用不影响上面两段）
      try {
        const projSnap = await buildActivityProjectSnapshot(env);
        await env.SHUMEI_KV.put(ACTIVITY_PROJECTS_KV_KEY, JSON.stringify(projSnap));
        console.log("[cron] activity projects refreshed:", projSnap.items.length);
      } catch (e) {
        console.log("[cron] activity projects refresh failed:", e.message);
      }
    })());
  },
};
