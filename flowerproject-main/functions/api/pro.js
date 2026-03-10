function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function parseAllowedOrigins(env, requestOrigin) {
  const fromEnv = String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return new Set([requestOrigin, ...fromEnv]);
}

function originFromHeaderValue(candidate) {
  if (!candidate) return "";
  try {
    return new URL(candidate).origin;
  } catch {
    return "";
  }
}

function resolveAllowedOrigin(request, allowedOrigins) {
  const originHeader = String(request.headers.get("origin") || "").trim();
  if (originHeader && allowedOrigins.has(originHeader)) {
    return originHeader;
  }

  const refererOrigin = originFromHeaderValue(request.headers.get("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) {
    return refererOrigin;
  }

  return "";
}

function corsHeadersFor(req, allowedOrigin) {
  const requestUrl = new URL(req.url);
  const requestOrigin = requestUrl.origin;
  const finalOrigin = allowedOrigin || requestOrigin;
  return {
    "Access-Control-Allow-Origin": finalOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function buildFallbackResult(prompt, paletteKey) {
  const key = String(paletteKey || "white_green");
  const paletteLabel = {
    white_green: "화이트·그린",
    pink_peach: "핑크·피치",
    lilac: "라일락",
    red_wine: "레드·버건디",
    yellow_orange: "옐로·오렌지",
  }[key] || "내추럴";

  const topic = String(prompt || "상황")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);

  return {
    one_line: `${paletteLabel} 톤으로 정리한 안전한 추천안입니다.`,
    bouquet_spec:
      `메인 3~4송이 + 보조 6~10송이 + 그린 1~2종\n` +
      `팔레트: ${paletteLabel}\n` +
      `질감 대비(라운드+라인)를 섞어 입체감을 살리는 구성을 권장`,
    budget: "M 기준 5만~8만 원 (기념일은 L 8만~13만 원 권장)",
    order_copy:
      `[요청] ${topic || "상황 맞춤 추천"}\n` +
      `[톤] ${paletteLabel}\n` +
      `[구성] 메인 3~4, 서브 6~10, 그린 1~2종\n` +
      `[포장] 무광 포장지 + 리본 1개(과하지 않게)\n` +
      `[주의] 과한 색 혼합/한 송이 과대 강조는 피하기`,
    detail_secret:
      "포인트 컬러는 1개만 유지하고, 나머지는 톤온톤으로 맞추면 실패 확률이 낮습니다.",
    card_lines: [
      "첫 DM은 예산+톤+용도 3가지만 명확히 전달",
      "재고 없으면 같은 톤의 시즌꽃으로 대체 요청",
      "사진 전달 시 전체 실루엣이 보이는 컷을 함께 요청",
    ],
    avoid: ["채도 높은 다색 혼합", "리본/포장 과다", "정면에서 메인꽃 1송이만 과대 강조"],
    image_url: "",
    source: "fallback_pro_v1",
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;
  const allowedOrigins = parseAllowedOrigins(env, requestOrigin);
  const allowedOrigin = resolveAllowedOrigin(request, allowedOrigins);
  const cors = corsHeadersFor(request, allowedOrigin || requestOrigin);

  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  if (!allowedOrigin) return json({ error: "forbidden_origin" }, 403, cors);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400, cors);
  }

  const prompt = String(body?.prompt || "").trim();
  const paletteKey = String(body?.paletteKey || "").trim();
  if (!prompt) return json({ error: "prompt_required" }, 400, cors);

  return json(buildFallbackResult(prompt, paletteKey), 200, cors);
}
