/**
 * Cloudflare Worker — 静态站点 + 成员查询 API
 * GET /api/member?uid=<卡号>   → 查询飞书多维表
 * GET /api/member?q=<姓名>     → 搜索飞书多维表
 * 其他请求 → 走静态资源
 */

let cachedToken = null;
let tokenExpiry = 0;

async function getToken(env) {
  const now = Date.now();
  if (cachedToken && tokenExpiry > now + 60000) return cachedToken;

  const resp = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    }
  );

  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(data.msg);

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

async function handleApi(request, env) {
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  const query = url.searchParams.get("q");

  if (!uid && !query) {
    return Response.json({ found: false }, { status: 400 });
  }

  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  if (!FEISHU_APP_ID) {
    return Response.json({ found: false }, { status: 500 });
  }

  try {
    const token = await getToken(env);

    let filter;
    if (uid) {
      filter = `CurrentValue.[社员卡号] = "${uid.trim().toUpperCase().replace(/:/g, "")}"`;
    } else {
      const q = query.trim();
      filter = `OR(CurrentValue.[姓名]="${q}",CurrentValue.[别名]="${q}",CurrentValue.[社员编号]="${q}",CurrentValue.[社员识别码]="${q}",CurrentValue.[社员身份编码（认读码）]="${q}",CurrentValue.[社员序号]="${q}")`;
    }

    const apiURL = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_APP_TOKEN}/tables/${FEISHU_TABLE_ID}/records?filter=${encodeURIComponent(filter)}&page_size=1`;

    const resp = await fetch(apiURL, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return Response.json({ found: false }, { status: 502 });

    const data = await resp.json();
    if (data.code !== 0 || !data.data?.items?.length) {
      return Response.json({ found: false });
    }

    const f = data.data.items[0].fields;
    return Response.json({
      found: true,
      member: {
        name: text(f, "姓名"),
        alias: text(f, "别名"),
        idCode: text(f, "社员编号"),
        generation: text(f, "年级"),
        className: text(f, "班级（分班后）"),
        birthday: text(f, "生日"),
        contactQQ: text(f, "QQ"),
        department: text(f, "社团部门"),
        roles: text(f, "社团职务"),
        rating: text(f, "社员评级"),
        honors: text(f, "其他职务或荣誉"),
        college: text(f, "升学去向"),
        joinDate: text(f, "入社日期"),
        description: text(f, "详细介绍"),
        cardId: text(f, "社员卡号"),
        readableCode: text(f, "社员身份编码（认读码）"),
        memberSeq: text(f, "社员序号"),
      },
    });
  } catch (e) {
    return Response.json({ found: false }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/member") {
      return handleApi(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
