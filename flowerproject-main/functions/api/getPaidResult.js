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
  const originHeader = request.headers.get("origin");
  const allowedOrigins = parseAllowedOrigins(env, requestOrigin);
  const originAllowed = !originHeader || allowedOrigins.has(originHeader);
  const cors = corsHeadersFor(request, originAllowed ? originHeader : requestOrigin);

  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
  if (!originAllowed) return json({ ok: false, error: "forbidden_origin" }, 403, cors);

  const rid = String(requestUrl.searchParams.get("rid") || "").trim();
  if (!rid) return json({ ok: false, error: "rid_required" }, 400, cors);

  const kv = env?.RESULTS_KV || null;
  if (!kv) return json({ ok: false, error: "result_not_found" }, 404, cors);

  let raw = null;
  try {
    raw = await kv.get(`paid:${rid}`);
    if (!raw) raw = await kv.get(rid);
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
