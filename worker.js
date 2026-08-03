/**
 * Cloudflare Worker — 静态站点 + 成员查询 API
 * GET /api/members              → 返回全部成员（供前端离线缓存）
 * GET /api/member?uid=<卡号>     → 查询飞书多维表
 * GET /api/member?q=<姓名>       → 搜索飞书多维表
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

async function handleMember(request, env) {
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  const query = url.searchParams.get("q");
  if (!uid && !query) return Response.json({ found: false }, { status: 400 });

  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  if (!FEISHU_APP_ID) return Response.json({ found: false }, { status: 500 });

  try {
    const token = await getToken(env);
    let filter;
    if (uid) {
      const n = uid.trim().toUpperCase().replace(/:/g, "");
      filter = `OR(CurrentValue.[社员卡号]="${n}",CurrentValue.[社员识别码]="${n}",CurrentValue.[社员身份编码（认读码）]="${n}")`;
    } else {
      const q = query.trim();
      filter = `OR(CurrentValue.[姓名]="${q}",CurrentValue.[别名]="${q}",CurrentValue.[社员编号]="${q}",CurrentValue.[社员识别码]="${q}",CurrentValue.[社员身份编码（认读码）]="${q}",CurrentValue.[社员序号]="${q}")`;
    }

    const apiURL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?filter=${encodeURIComponent(filter)}&page_size=1`;
    const resp = await fetch(apiURL, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      return Response.json({ found: false, _debug: `Feishu HTTP ${resp.status}`, _filter: filter }, { status: 502 });
    }
    const data = await resp.json();
    if (data.code !== 0) {
      return Response.json({ found: false, _debug: `Feishu code=${data.code} msg=${data.msg}`, _filter: filter });
    }
    if (!data.data?.items?.length) {
      return Response.json({ found: false, _debug: "No items", _filter: filter, _total: data.data?.total });
    }

    return Response.json({ found: true, member: buildMember(data.data.items[0].fields) });
  } catch (e) {
    return Response.json({ found: false }, { status: 500 });
  }
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
        if (cid) cardMap[cid] = name;
        if (bid) barcodeMap[bid] = name;
        if (rid) barcodeMap[rid] = name;
        if (!infoMap[name]) {
          infoMap[name] = {
            idCode: text(f, "社员编号"),
            dept: text(f, "社团部门"),
            cls: text(f, "班级（分班后）"),
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/members") return handleMembers(env);
    if (url.pathname === "/api/member") return handleMember(request, env);
    return env.ASSETS.fetch(request);
  },
};
