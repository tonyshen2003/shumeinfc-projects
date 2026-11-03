#!/usr/bin/env node
/**
 * 「禁止查询＝除名」（1.20.0）上线前后对比检测
 *
 * 用法：
 *   node docs/expulsion-check.js capture   # 部署【前】跑：抓基线 → docs/expulsion-baseline.json
 *   node docs/expulsion-check.js compare   # 部署【后 ≥5 分钟】跑：重跑同一套探针，与基线逐项对比
 *
 * 说明：
 *   - 基线文件只存数字/布尔/状态码/活动 record_id（公开值），不含姓名/卡号/识别码，可入库；
 *     被测样本每次运行时从 /api/members/full 自动发现（勾选「禁止查询」者），无需传参。
 *   - 所有请求带 _t= 时间戳绕开 CDN 60s 缓存；detail / activity 的边缘缓存 300s，
 *     部署后请等 5 分钟再 compare（否则被除名者 detail 可能仍是旧缓存的 found:true，造成假阴性）。
 *   - 部署后被除名者已从 /api/members/full 消失（这本身就是成功信号），脚本发现不了样本 →
 *     其探针按「预期消失」判定；若需再次真实验证 uid/q/find-code 实时路径，用检测文档的
 *     「临时标记法」，或直接用其认读码/姓名手测（认读码在管理台/飞书表可查）。
 *   - 需要 Node 18+（内置 fetch）。可用 BASE 环境变量覆盖目标域名。
 */

const fs = require("fs");
const path = require("path");
const BASE = (process.env.BASE || "https://nfc.raspjam.com").replace(/\/$/, "");
const BASELINE_FILE = path.join(__dirname, "expulsion-baseline.json");

// ---------- 工具（与 worker.js 口径一致） ----------
const text = (f, k) => {
  const v = f == null ? null : f[k];
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((i) => (i && i.text) || String(i || "")).filter(Boolean).join(", ");
  return (v && v.text) || "";
};
const isBlocked = (f) => {
  const v = f ? f["禁止查询"] : null;
  return v === true || v === "true" || v === 1;
};
const normUid = (s) => String(s || "").trim().toUpperCase().replace(/:/g, "");
const firstCard = (f) => {
  const cards = text(f, "社员卡号").split(";").map((s) => s.trim()).filter(Boolean);
  return cards.length ? normUid(cards[0]) : "";
};
const fileTokenOf = (f, key) => {
  const v = f == null ? undefined : f[key];
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  for (const it of arr) if (it && typeof it.file_token === "string" && it.file_token) return it.file_token;
  return "";
};

let REQ_COUNT = 0;
const TIMEOUT_MS = 20000;
async function get(pathname) {
  REQ_COUNT++;
  const sep = pathname.includes("?") ? "&" : "?";
  try {
    const r = await fetch(BASE + pathname + sep + "_t=" + Date.now(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: null, error: String(e.message || e) };
  }
}
const found = (r) => !!(r.json && r.json.found);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- 探针集（capture 与 compare 跑同一套） ----------
async function runProbes() {
  const probes = {};
  REQ_COUNT = 0;

  // 1) 全量快照与样本发现
  const full = await get("/api/members/full");
  const items = (full.json && full.json.items) || [];
  const blocked = items.filter((it) => isBlocked(it.fields));
  const normItem = items.find((it) => !isBlocked(it.fields)
    && text(it.fields, "姓名") && text(it.fields, "社员识别码") && firstCard(it.fields));
  probes.full = { status: full.status, total: items.length, blockedCount: blocked.length };

  // 姓名唯一性（?q= 与 find-code 需要）
  const nameCount = {};
  for (const it of items) {
    const n = text(it.fields, "姓名");
    if (n) nameCount[n] = (nameCount[n] || 0) + 1;
  }

  // 2) H5 映射表（/api/members）
  const maps = await get("/api/members");
  probes.members_map = {
    status: maps.status,
    cardKeys: maps.json ? Object.keys(maps.json.cardMap || {}).length : null,
    barcodeKeys: maps.json ? Object.keys(maps.json.barcodeMap || {}).length : null,
    infoKeys: maps.json ? Object.keys(maps.json.infoMap || {}).length : null,
  };

  // 3) 被除名社员逐个探测（uid 两路 / q / detail / find-code）
  blocked.forEach((it, i) => {
    const f = it.fields;
    const name = text(f, "姓名");
    const code = normUid(text(f, "社员识别码"));
    const uid = firstCard(f);
    const grade = text(f, "年级");
    const dept = text(f, "社团部门");
    const seq = text(f, "社员编号");
    const b = (probes["blocked" + (i + 1)] = { nameUnique: nameCount[name] === 1 });
    b.hasUid = !!uid; b.hasCode = !!code;
  });
  for (let i = 0; i < blocked.length; i++) {
    const f = blocked[i].fields;
    const key = "blocked" + (i + 1);
    const uid = firstCard(f);
    const code = normUid(text(f, "社员识别码"));
    const name = text(f, "姓名");
    if (uid) {
      const r = await get("/api/member?uid=" + encodeURIComponent(uid));
      probes[key].uid = { status: r.status, found: found(r) };
    }
    if (name && probes[key].nameUnique) {
      const r = await get("/api/member?q=" + encodeURIComponent(name));
      probes[key].q = { status: r.status, found: found(r) };
      // find-code：姓名 + 两个强字段
      const conds = [];
      if (text(f, "年级")) conds.push(["grade", text(f, "年级")]);
      if (text(f, "社团部门")) conds.push(["dept", text(f, "社团部门")]);
      if (text(f, "社员编号")) conds.push(["seq", text(f, "社员编号")]);
      if (conds.length >= 2) {
        const qs = conds.slice(0, 2).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
        const r = await get("/api/members/find-code?name=" + encodeURIComponent(name) + "&" + qs);
        probes[key].findcode = { status: r.status, found: found(r) };
      }
    }
    if (code) {
      const r = await get("/api/members/detail?code=" + encodeURIComponent(code));
      probes[key].detail = { status: r.status, found: found(r) };
    }
    await sleep(200);
  }

  // 4) 正常对照组
  if (normItem) {
    const f = normItem.fields;
    const name = text(f, "姓名");
    const code = normUid(text(f, "社员识别码"));
    const uid = firstCard(f);
    const c = (probes.norm = {});
    const rUid = await get("/api/member?uid=" + encodeURIComponent(uid));
    c.uid = { status: rUid.status, found: found(rUid) };
    const rDet = await get("/api/members/detail?code=" + encodeURIComponent(code));
    c.detail = {
      status: rDet.status,
      found: found(rDet),
      activityCount: rDet.json && rDet.json.member ? rDet.json.member.activityCount : null,
    };
    if (name && nameCount[name] === 1 && text(f, "年级") && text(f, "社团部门")) {
      const r = await get("/api/members/find-code?name=" + encodeURIComponent(name)
        + "&grade=" + encodeURIComponent(text(f, "年级")) + "&dept=" + encodeURIComponent(text(f, "社团部门")));
      c.findcode = { status: r.status, found: found(r) };
    }
    const avToken = fileTokenOf(f, "头像");
    if (avToken) {
      try {
        const r = await fetch(BASE + "/api/avatar?token=" + encodeURIComponent(avToken), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        c.avatar = { status: r.status };
      } catch (e) { c.avatar = { status: 0 }; }
    }
  }

  // 5) 活动列表 + 12 个抽样活动的统计（回归：不应有任何变化）
  const acts = await get("/api/activities?limit=200");
  const list = (acts.json && acts.json.items) || [];
  probes.activities = { status: acts.status, total: acts.json ? acts.json.total : null, sampled: 0, stats: [] };
  const step = Math.max(1, Math.floor(list.length / 12));
  const sampled = [];
  for (let i = 0; i < list.length && sampled.length < 12; i += step) sampled.push(list[i]);
  for (const a of sampled) {
    const r = await get("/api/activities/detail?id=" + encodeURIComponent(a.id));
    const st = r.json && r.json.activity && r.json.activity.stats;
    probes.activities.stats.push({
      id: a.id,
      status: r.status,
      people: st ? st.people : null,
      totalHours: st ? st.totalHours : null,
      volunteerHours: st ? st.volunteerHours : null,
    });
    probes.activities.sampled++;
    await sleep(100);
  }

  // 6) 照片代理（回归）
  const withPhoto = list.find((a) => a.photoCount > 0 && a.cover);
  if (withPhoto) {
    const m = /token=([^&]+)/.exec(withPhoto.cover);
    if (m) {
      try {
        const r = await fetch(BASE + "/api/photo?token=" + m[1] + "&w=400", { signal: AbortSignal.timeout(TIMEOUT_MS) });
        probes.photo = { status: r.status };
      } catch (e) { probes.photo = { status: 0 }; }
    }
  }

  // 7) 日历全量 / 证明目录（回归）
  let icsVevents = 0, icsStatus = 0;
  try {
    const raw = await fetch(BASE + "/calendar/activities.ics?all=1&_t=" + Date.now(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const t = await raw.text();
    icsVevents = (t.match(/^BEGIN:VEVENT/gm) || []).length;
    icsStatus = raw.status;
  } catch (e) { icsVevents = null; }
  probes.ics = { status: icsStatus, vevents: icsVevents };
  const pf = await get("/api/proof-files");
  probes.proof_files = { status: pf.status, count: pf.json && pf.json.files ? pf.json.files.length : null };

  return probes;
}

// ---------- 部署后预期值（capture 时静态算好，存进基线） ----------
function buildExpected(probes, items, blocked) {
  const exp = {};
  // 全量快照
  exp["full.total"] = probes.full.total - blocked.length;
  exp["full.blockedCount"] = 0;
  // H5 映射表：按被除名者的卡号/识别码/认读码/姓名精确计算减量
  let cardCut = 0, codeCut = 0, nameCut = 0;
  const nameCount = {};
  for (const it of items) {
    const n = text(it.fields, "姓名");
    if (n) nameCount[n] = (nameCount[n] || 0) + 1;
  }
  for (const b of blocked) {
    // handleMembers 以姓名为门槛：无姓名者部署前就不在映射中，减量为 0（2026-11-04 实测教训）
    if (!text(b.fields, "姓名")) continue;
    cardCut += text(b.fields, "社员卡号").split(";").map((s) => s.trim()).filter(Boolean).length;
    if (text(b.fields, "社员识别码")) codeCut++;
    if (text(b.fields, "社员身份编码（认读码）")) codeCut++;
    const n = text(b.fields, "姓名");
    if (nameCount[n] === 1) nameCut++;
  }
  exp["members_map.cardKeys"] = probes.members_map.cardKeys - cardCut;
  exp["members_map.barcodeKeys"] = probes.members_map.barcodeKeys - codeCut;
  exp["members_map.infoKeys"] = probes.members_map.infoKeys - nameCut;
  // 被除名者全部查无
  for (let i = 1; i <= blocked.length; i++) {
    for (const k of ["uid", "q", "findcode", "detail"]) {
      if (probes["blocked" + i] && probes["blocked" + i][k]) {
        exp["blocked" + i + "." + k + ".found"] = false;
        exp["blocked" + i + "." + k + ".status"] = probes["blocked" + i][k].status;
      }
    }
  }
  // 其余一律不变（compare 时按「应等于基线」处理）
  return exp;
}

// ---------- 扁平化与对比 ----------
function flatten(obj, prefix, out) {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    const key = prefix ? prefix + "." + k : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

async function main() {
  const mode = process.argv[2];
  if (mode === "capture") {
    const items0 = (await get("/api/members/full")).json.items || [];
    const blocked0 = items0.filter((it) => isBlocked(it.fields));
    const probes = await runProbes();
    const baseline = {
      meta: { capturedAt: new Date().toISOString(), base: BASE, note: "v1.20.0 除名功能部署前基线" },
      probes,
      expected: buildExpected(probes, items0, blocked0),
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
    console.log("基线已写入 " + BASELINE_FILE);
    console.log("共 " + REQ_COUNT + " 个请求；full.total=" + probes.full.total
      + " blocked=" + probes.full.blockedCount + "；活动抽样 " + probes.activities.sampled + " 个");
    console.log("部署完成 ≥5 分钟后执行：node docs/expulsion-check.js compare");
    return;
  }

  if (mode === "compare") {
    if (!fs.existsSync(BASELINE_FILE)) { console.error("找不到基线文件，先跑 capture"); process.exit(1); }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
    const probes = await runProbes();
    const base = flatten(baseline.probes, "", {});
    const exp = baseline.expected || {};
    const cur = flatten(probes, "", {});
    // 样本描述性元数据（随飞书维护漂移）不参与判定
    const META_RE = /(?:\.nameUnique|\.hasUid|\.hasCode|\.sampled)$/;
    // 被除名者的行为探针：found=false 才是部署后的正确状态
    const BLOCKED_PROBE_RE = /^blocked\d+\.(?:uid|q|findcode|detail)\./;
    let pass = 0, fail = 0, changed = 0;
    const lines = [];
    const baseBlocked = (baseline.probes.full && baseline.probes.full.blockedCount) || 0;
    const curBlocked = probes.full.blockedCount;
    const removalDone = curBlocked < baseBlocked; // 除名已生效（被除名者从全量快照消失）
    for (const key of Object.keys(base)) {
      if (META_RE.test(key)) continue; // 元数据不比对
      // 部署后被除名者无法再从 /api/members/full 发现 → 其探针按「预期消失」判定
      const m = /^blocked(\d+)\./.exec(key);
      if (m && removalDone && Number(m[1]) > curBlocked) {
        pass++;
        if (key.endsWith(".found")) {
          lines.push("  [预期消失✓] " + key + ": 基线=" + JSON.stringify(base[key]) + " → 探针无样本（该社员已从全量快照剔除，即除名生效）");
        }
        continue;
      }
      const b = base[key], c = cur[key];
      const e = key in exp ? exp[key] : b; // 无特殊预期 = 应等于基线
      const same = String(b) === String(c);
      if (same) { pass++; continue; }
      changed++;
      const label = key.replace(/^probes\./, "");
      // 映射表减量：除名生效 + 数值变小 → 方向正确，减量需人工核对（基线预期公式可能未考虑姓名门槛）
      if (/^members_map\./.test(key) && removalDone && typeof c === "number" && c < b) {
        pass++;
        lines.push("  [预期方向✓] " + label + ": " + b + " → " + c + "（减量应等于「有姓名的被除名者」贡献的键数；无姓名者本就不在映射）");
        continue;
      }
      const ok = String(c) === String(e);
      if (ok) { pass++; lines.push("  [预期变更✓] " + label + ": " + JSON.stringify(b) + " → " + JSON.stringify(c)); }
      else {
        fail++;
        const drift = /^(full|members_map|activities)\./.test(key)
          ? "  ← 若仅差 1~2：可能是窗口期飞书数据被维护（新社员/改字段），重跑 capture 后再 compare"
          : "";
        const hint = /blocked\d+\.detail\.found/.test(key) && c === true
          ? "  ← 可能是边缘缓存 300s 未过期：等 5 分钟后重跑 compare"
          : drift;
        lines.push("  [异常✗] " + label + ": 基线=" + JSON.stringify(b) + " 现在=" + JSON.stringify(c) + " 预期=" + JSON.stringify(e) + hint);
      }
    }
    for (const key of Object.keys(cur)) if (!(key in base)) {
      if (META_RE.test(key)) continue;
      if (BLOCKED_PROBE_RE.test(key) && key.endsWith(".found")) {
        if (cur[key] === false) {
          pass++;
          lines.push("  [新增·预期✓] " + key + " = false（查无此人，符合除名预期；基线时该探针因姓名不唯一被跳过）");
        } else {
          fail++;
          lines.push("  [异常✗] " + key + " = " + JSON.stringify(cur[key]) + "（被除名者仍可被查到——部署前为正常现状，部署后必须为 false）");
        }
        continue;
      }
      if (BLOCKED_PROBE_RE.test(key)) continue; // status 等附属值随 found 判定，不单独报
      fail++;
      lines.push("  [新增✗] " + key + " = " + JSON.stringify(cur[key]) + "（基线中不存在，确认是否样本变化）");
    }
    console.log("对比完成（" + REQ_COUNT + " 个请求）：不变/符合预期 " + pass + " 项，发生变化 " + changed + " 项，异常 " + fail + " 项\n");
    if (lines.length) console.log(lines.join("\n"));
    console.log(fail === 0 ? "\n✅ 全部通过：除名功能按预期生效，回归无损伤。" : "\n❌ 有 " + fail + " 项异常，按提示排查；必要时用逃生通道（飞书取消勾选）或 git revert。");
    process.exit(fail === 0 ? 0 : 2);
  }

  console.error("用法：node docs/expulsion-check.js capture | compare");
  process.exit(1);
}

main().catch((e) => { console.error("运行失败：", e); process.exit(1); });
