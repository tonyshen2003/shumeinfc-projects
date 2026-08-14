/**
 * Cloudflare Worker — 静态站点 + 成员查询 API
 * GET /api/members              → 返回全部成员（供前端离线缓存）
 * GET /api/members/full         → 返回全部成员原始记录（含 record_id，供 App 本地快照）
 * GET /api/member?uid=<卡号>     → 查询飞书多维表
 * GET /api/member?q=<姓名>       → 搜索飞书多维表
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

/** 头像：优先「头像」字段，其次回退「个人照片」第一张（与 DeepMei App 一致）。 */
function avatarUrl(fields) {
  return attachmentUrl(fields, "头像") || attachmentUrl(fields, "个人照片");
}

/**
 * 把飞书附件 tmp_url 换成浏览器可直接加载的临时下载链接。
 * 飞书的 tmp_url 是 batch_get_tmp_download_url 接口地址，需要带 tenant token 请求后
 * 从 data.tmp_download_urls[0].tmp_download_url 取真实图片地址（与 DeepMei App 逻辑一致）。
 */
async function resolveAvatar(env, fields) {
  let item = null;
  for (const key of ["头像", "个人照片"]) {
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
const ACTIVITY_KV_KEY = "activity_records";

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
    const memberCode = memberIds.length ? (memberCodeByRecord[memberIds[0]] || "") : "";
    if (!memberCode) continue;

    const actId = actIds[0] || "";
    const act = activityByRecord[actId] || {};
    const activityHours = numVal(f["活动时长（小时）"] ?? f["实际时长（小时）"]);

    // 兼容两种模型：明细表已拆「志愿服务时长」时直接用；否则按「是否计入志愿时长」推导
    let volunteerHours;
    const rawVol = f["志愿服务时长（小时）"];
    if (rawVol !== undefined && rawVol !== null && rawVol !== "") {
      volunteerHours = numVal(rawVol);
    } else {
      volunteerHours = String(f["是否计入志愿时长"] ?? "").trim() === "是" ? activityHours : 0;
    }

    items.push({
      memberCode,
      activityId: actId,
      activityName: act.name || text(f, "活动项目名称").trim(),
      activityType: act.type || text(f, "活动类型"),
      date: act.date || dateText(f["活动日期"]),
      role: text(f, "参与角色"),
      activityHours,
      volunteerHours,
    });
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
// 已放行头像 URL：服务端把飞书 tmp_url 换成可直接加载的临时下载链接；
// 无「头像」字段时回退「个人照片」第一张（与 App 一致）。
// /api/members/full 保持不变（App 等其它服务继续使用）。
// ============================================================
function num(fields, key) {
  const v = fields[key];
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
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
    totalHours: num(fields, "统计时长 (社团活动记录表)"),
    joinYear: joinYear(fields),
    seq: text(fields, "社员编号"),
    avatar: avatarUrl(fields),
  };
}

async function handleMemberDetail(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return Response.json({ found: false }, { status: 400 });
  if (!env.SHUMEI_KV || !env.FEISHU_APP_ID) return Response.json({ found: false }, { status: 500 });
  const n = code.trim().toUpperCase().replace(/:/g, "");
  try {
    const snap = await getSnapshot(env);
    for (const item of snap.items) {
      if (text(item.fields, "社员识别码").toUpperCase() === n) {
        const member = buildDetailMember(item.fields);
        member.avatar = await resolveAvatar(env, item.fields);
        try {
          const actSnap = await getActivitySnapshot(env);
          member.activities = actSnap.items.filter((i) => i.memberCode === n);
        } catch (e) {
          member.activities = [];
        }
        return Response.json({ found: true, member });
      }
    }
    return Response.json({ found: false });
  } catch (e) {
    return Response.json({ found: false }, { status: 500 });
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
    await env.SHUMEI_KV.put(LAST_REFRESH_KEY, String(now));
    return Response.json({
      ok: true,
      updatedAt: snap.updatedAt,
      items: snap.items.length,
      activityItems: actSnap.items.length,
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
    if (url.pathname === "/api/members/detail") return handleMemberDetail(request, env);
    if (url.pathname === "/api/member") return handleMember(request, env);
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
    })());
  },
};
