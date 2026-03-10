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

function isValidRid(value) {
  return /^[A-Za-z0-9_-]{8,120}$/.test(String(value || ""));
}

function corsHeadersFor(req, allowedOrigin) {
  const requestUrl = new URL(req.url);
  const requestOrigin = requestUrl.origin;
  const finalOrigin = allowedOrigin || requestOrigin;
  return {
    "Access-Control-Allow-Origin": finalOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
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
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  if (!allowedOrigin) return json({ ok: false, error: "forbidden_origin" }, 403, cors);

  const rid = String(requestUrl.searchParams.get("rid") || "").trim();
  if (!rid) return json({ ok: false, error: "rid_required" }, 400, cors);
  if (!isValidRid(rid)) return json({ ok: false, error: "rid_invalid" }, 400, cors);

  const kv = env?.RESULTS_KV || null;
  if (!kv) return json({ ok: false, error: "result_not_found" }, 404, cors);

  let raw = null;
  try {
    raw = await kv.get(`paid:${rid}`);
  } catch {
    return json({ ok: false, error: "storage_unavailable" }, 500, cors);
  }

  if (!raw) return json({ ok: false, error: "result_not_found" }, 404, cors);

  try {
    const parsed = JSON.parse(raw);
    return json({ ok: true, result: parsed }, 200, cors);
  } catch {
    return json({ ok: true, result: { raw_text: String(raw) } }, 200, cors);
  }
}
