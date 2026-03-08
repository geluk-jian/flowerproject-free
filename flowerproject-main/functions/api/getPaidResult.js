// functions/api/getPaidResult.js
// GET /api/getPaidResult?rid=...

function corsHeadersFor(req) {
  const requestUrl = new URL(req.url);
  const requestOrigin = requestUrl.origin;
  const originHeader = req.headers.get("Origin");
  const allowedOrigin = isSameOrigin(originHeader, requestOrigin) ? originHeader : requestOrigin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const cors = corsHeadersFor(request);
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;
  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  const originAllowed =
    !originHeader ||
    isSameOrigin(originHeader, requestOrigin) ||
    isSameOrigin(refererHeader, requestOrigin);

  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
  if (!originAllowed) return json({ error: "forbidden_origin" }, 403, cors);

  if (!env?.RESULTS_KV) {
    return json({ error: "missing_kv_binding", hint: "KV binding name must be RESULTS_KV" }, 500, cors);
  }

  const rid = String(new URL(request.url).searchParams.get("rid") || "").trim();
  if (!rid) return json({ ok: false, error: "rid_required" }, 400, cors);

  const raw = await env.RESULTS_KV.get(`paid:${rid}`);
  if (!raw) return json({ ok: false, error: "not_found" }, 404, cors);

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "invalid_saved_payload" }, 500, cors);
  }

  return json(
    {
      ok: true,
      rid: parsed?.rid || rid,
      savedAt: parsed?.savedAt || null,
      result: parsed?.result || null,
      meta: parsed?.meta || null,
    },
    200,
    cors
  );
}

function isSameOrigin(candidate, origin) {
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}
