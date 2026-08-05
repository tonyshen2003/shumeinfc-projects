/**
 * Cloudflare Worker — 静态站点 + 成员查询 API
 * GET /api/members              → 返回全部成员（供前端离线缓存）
 * GET /api/members/full         → 返回全部成员原始记录（含 record_id，供 App 本地快照）
 * GET /api/member?uid=<卡号>     → 查询飞书多维表
 * GET /api/member?q=<姓名>       → 搜索飞书多维表
 * POST /api/checkin             → 签到提交（写 WPS + 发飞书通知）
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
  };
}

/** 按卡号/识别码/认读码查询单个社员，查不到返回 null。 */
async function findMemberByUid(env, uid) {
  const { FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  const token = await getToken(env);
  const n = uid.trim().toUpperCase().replace(/:/g, "");
  const filter = `OR(CurrentValue.[社员卡号].CONTAINS("${n}"),CurrentValue.[社员识别码]="${n}",CurrentValue.[社员身份编码（认读码）]="${n}")`;
  const apiURL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?filter=${encodeURIComponent(filter)}&page_size=1`;
  const resp = await fetch(apiURL, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.code !== 0 || !data.data?.items?.length) return null;
  return buildMember(data.data.items[0].fields);
}

async function handleMember(request, env) {
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  const query = url.searchParams.get("q");
  if (!uid && !query) return Response.json({ found: false }, { status: 400 });

  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  if (!FEISHU_APP_ID) return Response.json({ found: false }, { status: 500 });

  try {
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
async function handleCheckin(request, env) {
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

  // 2. 飞书群通知（失败不阻塞返回，记日志）
  if (env.FEISHU_BOT) {
    try {
      await sendFeishuBot(env, { uid, name, mode, activity, duration, lat, lng, member });
    } catch (e) {
      console.log("[checkin] Feishu bot send failed:", e.message);
    }
  }

  // 3. 写 WPS 多维表（失败不阻塞返回，记日志）
  if (env.WPS_WEBHOOK) {
    try {
      await pushToWps(env, { uid, name, activity, duration, member });
    } catch (e) {
      console.log("[checkin] WPS push failed:", e.message);
    }
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
  if (!env.FEISHU_APP_ID) return Response.json({ error: "Missing env vars" }, { status: 500 });
  try {
    const token = await getToken(env);
    const { FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
    const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?page_size=500`;

    const cardMap = {};
    const barcodeMap = {};
    const infoMap = {};
    let pageToken = null;

    do {
      let url = base;
      if (pageToken) url += `&page_token=${pageToken}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) break;
      const data = await resp.json();
      if (data.code !== 0) break;

      for (const item of data.data?.items || []) {
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
      pageToken = data.data?.page_token || null;
    } while (pageToken);

    return Response.json({ updatedAt: Date.now(), cardMap, barcodeMap, infoMap }, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ============================================================
// [API] 全量成员快照：分页拉取原始记录（含 record_id）
// 供 DeepMei App 本地缓存 24h，查询先命中快照再走在线 API。
// ============================================================
async function handleMembersFull(env) {
  if (!env.FEISHU_APP_ID) return Response.json({ error: "Missing env vars" }, { status: 500 });
  try {
    const token = await getToken(env);
    const { FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
    const base = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?page_size=500`;
    const items = [];
    let pageToken = null;

    do {
      let url = base;
      if (pageToken) url += `&page_token=${pageToken}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) break;
      const data = await resp.json();
      if (data.code !== 0) break;

      for (const item of data.data?.items || []) {
        items.push({ recordId: item.record_id, fields: item.fields });
      }
      pageToken = data.data?.page_token || null;
    } while (pageToken);

    return Response.json({ updatedAt: Date.now(), items }, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/members") return handleMembers(env);
    if (url.pathname === "/api/members/full") return handleMembersFull(env);
    if (url.pathname === "/api/member") return handleMember(request, env);
    if (url.pathname === "/api/checkin" && request.method === "POST") return handleCheckin(request, env);
    return env.ASSETS.fetch(request);
  },
};
