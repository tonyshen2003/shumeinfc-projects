/**
 * Cloudflare Pages Function — 成员查询 API
 *
 * GET /api/member?uid=<cardUid>    → 按 NFC 卡号查成员
 * GET /api/member?q=<searchText>   → 按姓名/别名/编号搜索成员
 *
 * 飞书 API 凭据通过 Cloudflare Pages 环境变量注入，不暴露到前端。
 */

// 飞书 tenant_access_token 缓存（同一个 isolate 内复用，避免每次请求都调 token 接口）
let cachedToken = null;
let tokenExpiry = 0;

const FEISHU_AUTH_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";

function buildBitableURL(appToken, tableId) {
  return `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`;
}

async function getTenantAccessToken(env) {
  const now = Date.now();
  if (cachedToken && tokenExpiry > now + 60000) {
    return cachedToken;
  }

  const resp = await fetch(FEISHU_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: env.FEISHU_APP_ID,
      app_secret: env.FEISHU_APP_SECRET,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Feishu auth failed: ${resp.status}`);
  }

  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`Feishu auth error: ${data.msg}`);
  }

  cachedToken = data.tenant_access_token;
  tokenExpiry = now + 7200 * 1000; // 2 小时
  return cachedToken;
}

function mapRecord(fields) {
  const text = (key) => {
    const v = fields[key];
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v)) {
      return v
        .map((item) => {
          if (item && typeof item === "object" && item.text) return item.text;
          if (typeof item === "string" || typeof item === "number") return String(item);
          return "";
        })
        .filter(Boolean)
        .join(", ");
    }
    if (v && typeof v === "object" && v.text) return v.text;
    return "";
  };

  return {
    name: text("姓名"),
    alias: text("别名"),
    idCode: text("社员编号"),
    generation: text("年级"),
    className: text("班级（分班后）"),
    birthday: text("生日"),
    contactQQ: text("QQ"),
    department: text("社团部门"),
    roles: text("社团职务"),
    rating: text("社员评级"),
    honors: text("其他职务或荣誉"),
    college: text("升学去向"),
    joinDate: text("入社日期"),
    description: text("详细介绍"),
    cardId: text("社员卡号"),
    readableCode: text("社员身份编码（认读码）"),
    memberSeq: text("社员序号"),
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const uid = url.searchParams.get("uid");
  const query = url.searchParams.get("q");

  if (!uid && !query) {
    return Response.json({ found: false, error: "Missing uid or q parameter" }, { status: 400 });
  }

  // 校验必需的环境变量
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_APP_TOKEN || !FEISHU_TABLE_ID) {
    return Response.json(
      { found: false, error: "Server config missing" },
      { status: 500 }
    );
  }

  try {
    const token = await getTenantAccessToken(env);

    // 构造飞书 Bitable 筛选条件
    let filterFormula;
    if (uid) {
      const normalized = uid.trim().toUpperCase().replace(/:/g, "");
      filterFormula = `CurrentValue.[社员卡号] = "${normalized}"`;
    } else {
      const q = query.trim();
      filterFormula = [
        `CurrentValue.[姓名] = "${q}"`,
        `CurrentValue.[别名] = "${q}"`,
        `CurrentValue.[社员编号] = "${q}"`,
        `CurrentValue.[社员识别码] = "${q}"`,
        `CurrentValue.[社员身份编码（认读码）] = "${q}"`,
        `CurrentValue.[社员序号] = "${q}"`,
      ].join(",");
      filterFormula = `OR(${filterFormula})`;
    }

    const bitableURL = buildBitableURL(FEISHU_APP_TOKEN, FEISHU_TABLE_ID);
    const apiURL = `${bitableURL}?filter=${encodeURIComponent(filterFormula)}&page_size=1`;

    const resp = await fetch(apiURL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      return Response.json({ found: false, error: `Feishu API error: ${resp.status}` }, { status: 502 });
    }

    const data = await resp.json();
    if (data.code !== 0) {
      return Response.json({ found: false, error: data.msg }, { status: 502 });
    }

    const items = data.data?.items;
    if (!items || items.length === 0) {
      return Response.json({ found: false });
    }

    const member = mapRecord(items[0].fields);
    return Response.json({ found: true, member });
  } catch (err) {
    return Response.json({ found: false, error: err.message }, { status: 500 });
  }
}
