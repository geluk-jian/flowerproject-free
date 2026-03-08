function isSameOrigin(candidate, origin) {
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}

function normalizeStr(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildCacheKey(body) {
  // 같은 입력이면 같은 키가 되게 (필요한 값만 포함)
  const payload = {
    prompt: normalizeStr(body?.prompt),
    freeText: normalizeStr(body?.free_text || body?.freeText),
    mainFlower: normalizeStr(body?.mainFlower),
    paletteKey: normalizeStr(body?.paletteKey),
    input: body?.input ?? null,
    images: (Array.isArray(body?.images) ? body.images : [])
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim()),
  };
  const raw = JSON.stringify(payload);
  const hash = await sha256Hex(raw);
  return `pro:v1:${hash}`;
}

function extractText(responseData) {
  if (!responseData || typeof responseData !== "object") return "";
  if (typeof responseData.output_text === "string" && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }

  const outputs = Array.isArray(responseData.output) ? responseData.output : [];
  const parts = [];

  for (const item of outputs) {
    const contents = Array.isArray(item?.content) ? item.content : [];
    for (const content of contents) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n\n").trim();
}

function pickTagBlock(text, tag) {
  const s = String(text || "");
  const start = `[${tag}]`;
  const end = `[/${tag}]`;
  const i = s.indexOf(start);
  const j = s.indexOf(end);
  if (i === -1 || j === -1 || j <= i) return "";
  return s.slice(i + start.length, j).trim();
}

function splitLines(block) {
  return String(block || "")
    .split("\n")
    .map((v) => v.replace(/^\s*[-•]\s*/, "").trim())
    .filter(Boolean);
}

async function generateBouquetImage({ apiKey, text, prompt, mainFlower, paletteKey }) {
  const key = String(paletteKey || "").trim().toLowerCase() || "pink_peach";

  const SETS = {
    pink_peach: {
      label: "pink-peach",
      mood: "elegant, romantic, soft",
      focal: ["rose", "lisianthus"],
      secondary: ["spray roses", "small carnations"],
      filler: "waxflower",
      greenery: ["eucalyptus", "ruscus"],
      bg: "light gray seamless backdrop with subtle gradient",
    },
    yellow_orange: {
      label: "yellow-orange",
      mood: "bright, cheerful, clean",
      focal: ["tulips", "roses"],
      secondary: ["spray roses", "lisianthus"],
      filler: "solidago",
      greenery: ["eucalyptus", "pittosporum"],
      bg: "light gray seamless backdrop with subtle gradient",
    },
    red_wine: {
      label: "deep red / burgundy",
      mood: "moody, chic, luxurious",
      focal: ["deep red roses", "ranunculus"],
      secondary: ["deep red spray roses", "small carnations"],
      filler: "hypericum berries",
      greenery: ["ruscus", "eucalyptus"],
      bg: "light gray seamless backdrop with subtle gradient",
    },
    white_green: {
      label: "white-green",
      mood: "minimal, clean, modern",
      focal: ["white roses", "white lisianthus"],
      secondary: ["spray roses"],
      filler: "baby's breath",
      greenery: ["eucalyptus", "ruscus"],
      bg: "light gray seamless backdrop with subtle gradient",
    },
    lilac: {
      label: "lilac / lavender",
      mood: "elegant, dreamy, refined",
      focal: ["purple lisianthus", "roses"],
      secondary: ["spray roses"],
      filler: "statice",
      greenery: ["eucalyptus", "ruscus"],
      bg: "light gray seamless backdrop with subtle gradient",
    },
  };

  const set = SETS[key] || SETS.pink_peach;

  const mf = String(mainFlower || "").trim();
  const mainRule = mf
    ? `Include "${mf}" as ONE of the 3 focal blooms (medium size), NOT oversized. Show THREE focal blooms clearly visible from the front (similar size) in a triangular composition—no single hero bloom.`
    : "Show THREE focal blooms clearly visible from the front (similar size) in a triangular composition—no single hero bloom.";

  // 이미지용 스펙(짧고 명확하게) — text 전체를 넣지 않음(혼란 방지)
  const shortConcept = [
    "Korean florist bouquet, premium realistic studio product photo.",
    `Color palette: ${set.label}. Mood: ${set.mood}.`,
    "Balanced multi-flower bouquet:",
    "3 medium focal blooms + 6-10 secondary blooms + 1 filler flower + 1-2 airy greenery.",
    "Avoid: single flower bouquet, single daisy/gerbera dominating, one giant central bloom.",
    `Focal: ${set.focal.join(" + ")} (mixed, similar size).`,
    `Secondary: ${set.secondary.join(" + ")}.`,
    `Filler: ${set.filler}.`,
    `Greenery: ${set.greenery.join(" + ")}.`,
    mainRule,
  ].join("\n");

  const photoRules = [
    "Photorealistic studio product photography of a florist-designed hand-tied bouquet.",
    "Single bouquet centered, no text, no watermark, no logo, no people, no hands.",
    "Real paper wrap with subtle wrinkles and micro texture, satin ribbon.",
    `Softbox lighting, natural soft shadow on ${set.bg}.`,
    "85mm lens look, shallow depth of field, subtle film grain, high detail.",
    "Negative: no CGI, no 3D render, no illustration, avoid perfect symmetry, avoid plastic/waxy petals, avoid one giant central bloom dominating the bouquet.",
    "Avoid: single flower bouquet, single daisy/gerbera dominating, one giant central bloom.",
  ].join("\n");

  const imagePrompt = `${shortConcept}\n\n${photoRules}`;

  let imageRes;
  try {
    imageRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: imagePrompt,
        size: "1024x1024",
        quality: "medium",
      }),
    });
  } catch (e) {
    return null;
  }

  if (!imageRes.ok) return null;

  let imageData = null;
  try {
    imageData = await imageRes.json();
  } catch (e) {
    return null;
  }

  const first = Array.isArray(imageData?.data) ? imageData.data[0] : null;
  if (typeof first?.url === "string" && first.url.trim()) {
    return first.url.trim();
  }
  if (typeof first?.b64_json === "string" && first.b64_json.trim()) {
    return `data:image/png;base64,${first.b64_json.trim()}`;
  }

  return null;
}

export async function onRequestPost(context) {
  const requestUrl = new URL(context.request.url);
  const requestOrigin = requestUrl.origin;
  const originHeader = context.request.headers.get("origin");
  const refererHeader = context.request.headers.get("referer");
  const allowedOrigin = isSameOrigin(originHeader, requestOrigin)
    ? originHeader
    : requestOrigin;
  const originAllowed = !originHeader || isSameOrigin(originHeader, requestOrigin) || isSameOrigin(refererHeader, requestOrigin);

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };

  if (context.request.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders });
  }

  if (context.request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!originAllowed) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body = null;
  try {
    body = await context.request.json();
  } catch (e) {}

  const prompt = String(body?.prompt || "").trim();
  const mainFlower = String(body?.mainFlower || "").trim();
  const paletteKey = String(body?.paletteKey || "").trim();
  const input = Array.isArray(body?.input) ? body.input : null;
  if (!prompt && !input) {
    return new Response(JSON.stringify({ error: "prompt_required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = context.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "missing_openai_api_key" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ===== KV cache lookup (before OpenAI calls) =====
  const kv = context.env.FLOWER_CACHE; // 바인딩 이름 그대로
  let cacheKey = null;

  if (kv) {
    cacheKey = await buildCacheKey(body);
    const cached = await kv.get(cacheKey, { type: "json" });
    if (cached?.text && cached?.image_url) {
      const one_line = pickTagBlock(cached.text, "ONE_LINE");
      const bouquet_spec = pickTagBlock(cached.text, "BOUQUET_SPEC");
      const budget = pickTagBlock(cached.text, "BUDGET");
      const order_copy = pickTagBlock(cached.text, "ORDER_COPY");
      const detail_secret = pickTagBlock(cached.text, "DETAIL_SECRET");
      const card_lines = splitLines(pickTagBlock(cached.text, "CARD_LINES"));
      const avoid = splitLines(pickTagBlock(cached.text, "AVOID"));
      return new Response(
        JSON.stringify({
          image_url: cached.image_url,
          raw_text: cached.text,
          one_line,
          bouquet_spec,
          budget,
          order_copy,
          detail_secret,
          card_lines,
          avoid,
          cached: true,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  }

  const buildInput = () => {
    if (input) return input;
    const freeText = String(body?.free_text || body?.freeText || "").trim();
    const images = Array.isArray(body?.images) ? body.images : [];
    const systemText =
      "당신은 10년차 플로리스트입니다. 아래 입력을 바탕으로 ‘구매 실행형’ 추천서를 작성하세요.\n" +
      "중요: 선택지/슬래시(/)로 여러 옵션을 나열하지 말고, 각 항목은 ‘하나의 확정안’만 제시하세요.\n" +
      "과장 금지. 꽃집에서 바로 통하는 문장만.\n\n" +
      "출력은 반드시 아래 태그 형식을 정확히 지키세요(태그 누락 금지). 각 태그 안 내용은 2~5줄로 간결하게.\n\n" +
      "[ONE_LINE]\n" +
      "- 한 줄 결론(그냥 이대로 사면 됨)\n" +
      "[/ONE_LINE]\n\n" +
      "[BOUQUET_SPEC]\n" +
      "- 구성 규칙을 반드시 포함:\n" +
      "  포컬(중간 크기) 3송이(2종 믹스, ‘한 송이만 크게’ 금지)\n" +
      "  서브 6~10송이\n" +
      "  필러 1종\n" +
      "  그린 1~2종\n" +
      "- 팔레트/무드/관계에 맞는 꽃 이름을 한국 꽃집에서 통하는 표현으로 구체적으로\n" +
      "- 마지막 줄에: ‘계절/재고에 따라 유사 톤 소재로 대체 가능’ 1줄 추가\n" +
      "[/BOUQUET_SPEC]\n\n" +
      "[BUDGET]\n" +
      "- 예산/사이즈 추천(예: M 5~8만원)\n" +
      "- 왜 이 사이즈가 무난한지 1줄\n" +
      "[/BUDGET]\n\n" +
      "[ORDER_COPY]\n" +
      "- 꽃집 사장님에게 그대로 보내는 ‘복붙 주문서’ 1개(가장 중요)\n" +
      "- 반드시 포함: 예산, 팔레트, 무드, 포컬/서브/필러/그린 구성, 포장(포장지 톤/리본), 금지사항 1개\n" +
      "- 금지: 슬래시(/)로 옵션 나열, 괄호 안에 선택지 나열\n" +
      "[/ORDER_COPY]\n\n" +
      "[DETAIL_SECRET]\n" +
      "- 디테일 가이드(포장/꽃조합/그린/대체 규칙) 4~6줄\n" +
      "- 금지: 슬래시(/)로 여러 옵션 나열\n" +
      "[/DETAIL_SECRET]\n\n" +
      "[CARD_LINES]\n" +
      "- 남자가 쓰기 쉬운 카드 한줄 2개(짧고 안전하게)\n" +
      "[/CARD_LINES]\n\n" +
      "[AVOID]\n" +
      "- 피해야 할 실수 3개(짧게)\n" +
      "[/AVOID]\n";

    const content = [
      { type: "input_text", text: freeText || prompt },
      ...images
        .filter((v) => typeof v === "string" && v.trim())
        .map((image_url) => ({ type: "input_image", image_url })),
    ];

    return [
      {
        role: "system",
        content: [{ type: "input_text", text: systemText }],
      },
      {
        role: "user",
        content,
      },
    ];
  };

  const payload = {
    model: "gpt-4.1-mini",
    input: buildInput(),
    max_output_tokens: 900,
  };

  let upstream;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);
  try {
    upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      return new Response(JSON.stringify({ error: "upstream_timeout" }), {
        status: 504,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "upstream_fetch_failed" }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } finally {
    clearTimeout(timeoutId);
  }

  let data = null;
  try {
    data = await upstream.json();
  } catch (e) {}

  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: "openai_error", status: upstream.status, details: data || null }),
      {
        status: upstream.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  const text = extractText(data);
  const image_url = await generateBouquetImage({
    apiKey,
    text,
    prompt,
    mainFlower,
    paletteKey: String(body?.paletteKey || ""),
  });
  const one_line = pickTagBlock(text, "ONE_LINE");
  const bouquet_spec = pickTagBlock(text, "BOUQUET_SPEC");
  const budget = pickTagBlock(text, "BUDGET");
  const order_copy = pickTagBlock(text, "ORDER_COPY");
  const detail_secret = pickTagBlock(text, "DETAIL_SECRET");
  const card_lines = splitLines(pickTagBlock(text, "CARD_LINES"));
  const avoid = splitLines(pickTagBlock(text, "AVOID"));

  // ===== KV cache save (only on success) =====
  if (kv && cacheKey && text && image_url) {
    await kv.put(cacheKey, JSON.stringify({ text, image_url }), {
      expirationTtl: 60 * 60 * 24 * 14, // 14일
    });
  }

  return new Response(
    JSON.stringify({
      image_url,
      raw_text: text,
      one_line,
      bouquet_spec,
      budget,
      order_copy,
      detail_secret,
      card_lines,
      avoid,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
}
