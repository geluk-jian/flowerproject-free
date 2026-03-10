// functions/api/getFlowerGuide.js

const paletteMap = {
  white_green: {
    label: "화이트·그린",
    colors: [
      { hex: "#F8F7F2", name: "Ivory" },
      { hex: "#D9D9D6", name: "Mist" },
      { hex: "#C9D4C5", name: "Sage" },
    ],
  },
  pink_peach: {
    label: "핑크·피치",
    colors: [
      { hex: "#F7CAC9", name: "Blush" },
      { hex: "#F7B39B", name: "Peach" },
      { hex: "#F3E0BE", name: "Cream" },
    ],
  },
  lilac: {
    label: "연보라·라일락",
    colors: [
      { hex: "#E6D9F2", name: "Lilac" },
      { hex: "#C7B6E6", name: "Lavender" },
      { hex: "#9B84C9", name: "Iris" },
    ],
  },
  red_wine: {
    label: "레드·버건디",
    colors: [
      { hex: "#C94C5B", name: "Rose" },
      { hex: "#8B1E3F", name: "Wine" },
      { hex: "#F3D5DB", name: "Blush" },
    ],
  },
  yellow_orange: {
    label: "옐로·오렌지",
    colors: [
      { hex: "#FFD23F", name: "Sun" },
      { hex: "#FF8C42", name: "Tangerine" },
      { hex: "#FFE9CC", name: "Vanilla" },
    ],
  },
};

function normalizeCode(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function configuredVipCodes(env) {
  const list = String(env?.VIP_CODES || "")
    .split(",")
    .map((s) => normalizeCode(s))
    .filter(Boolean);
  return list.length ? list : ["TONEART"];
}

function isValidVipCode(allowedCodes, rawCode) {
  const input = normalizeCode(rawCode);
  if (!input) return false;
  return allowedCodes.includes(input);
}

function isSameOrigin(candidate, origin) {
  if (!candidate) return false;
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
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

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "unknown"
  );
}

async function enforceRateLimit({ request, env, vipCode }) {
  const kv = env?.RATE_LIMIT_KV || env?.RESULTS_KV || null;
  if (!kv) {
    // Allow serving responses even if KV binding is not configured yet.
    // This avoids total API outage while infra is being set up.
    return { ok: true, skipped: true, reason: "missing_rate_limit_kv_binding" };
  }

  const max = Math.max(1, Number(env?.VIP_RATE_LIMIT_MAX || 20));
  const windowSec = Math.max(30, Number(env?.VIP_RATE_LIMIT_WINDOW_SEC || 3600));
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const ip = getClientIp(request);
  const key = `viprl:v1:${normalizeCode(vipCode)}:${ip}:${bucket}`;

  let current = 0;
  try {
    current = Number((await kv.get(key)) || 0);
  } catch {
    return { ok: false, status: 500, error: "rate_limit_storage_unavailable" };
  }

  if (current >= max) {
    return { ok: false, status: 429, error: "too_many_requests" };
  }

  try {
    await kv.put(key, String(current + 1), { expirationTtl: windowSec + 60 });
  } catch {
    return { ok: false, status: 500, error: "rate_limit_storage_unavailable" };
  }

  return { ok: true };
}

// ✅ fallback 로컬 이미지(최소한 이 정도는 있어야 안전)
const flowerImgByKey = {
  rose: "/image/rose.png",
  calla: "/image/calla.png",
  gerbera: "/image/gerbera.png",
  lisianthus: "/image/lisianthus.png",
  tulip: "/image/tulip.png",
  ranunculus: "/image/ranunculus.png",
  carnation: "/image/carnation.png",
  hydrangea: "/image/hydrangea.png",
};

async function generateBouquetImageBase64({ apiKey, prompt }) {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1-mini",
      prompt,
      size: "1024x1024", // ✅ 일단 유지 (비용 방어)
      quality: "medium", // ✅ low → medium (디테일 개선)
      n: 1,
      output_format: "png",
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`image_generation_failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error("image_generation_no_b64");
  return `data:image/png;base64,${b64}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);
  const requestOrigin = requestUrl.origin;
  const originHeader = request.headers.get("origin");
  const allowedOrigins = parseAllowedOrigins(env, requestOrigin);
  // Same-origin requests may not always include Origin; allow them.
  const originAllowed = !originHeader || allowedOrigins.has(originHeader);
  const cors = corsHeadersFor(request, originAllowed ? originHeader : requestOrigin);
  const vipCodes = configuredVipCodes(env);

  if (request.method === "OPTIONS") return new Response("", { status: 204, headers: cors });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  if (!originAllowed) return json({ error: "forbidden_origin" }, 403, cors);
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json_body" }, 400, cors);
  }

  if (!isValidVipCode(vipCodes, body.vipCode)) {
    return json({ error: "vip_code_required_or_invalid" }, 403, cors);
  }

  const rateLimit = await enforceRateLimit({ request, env, vipCode: body.vipCode });
  if (!rateLimit.ok) {
    return json({ error: rateLimit.error }, rateLimit.status, cors);
  }

  try {
    const guide = await buildGuide(body, env);
    return json(guide, 200, cors);
  } catch (error) {
    return json({ error: "guide_generation_failed" }, 500, cors);
  }
}

/**
 * ✅ 프론트(renderVipResult)가 기대하는 키:
 * imageUrl, targetName, moodLabel, orderText, wrapGuide, flowerMix, palettes, messages, priceInfo, meaning
 */
async function buildGuide(body, env) {
  const relationRaw = String(body?.relation ?? "상대").trim();
  const occasionRaw = String(body?.occasion ?? "선물").trim();
  const styleKey = String(body?.style ?? "chic_elegant").trim();
  const paletteKey = String(body?.palette ?? "white_green").trim();
  const photoHabitKey = String(body?.photoHabit ?? "sns_sometimes").trim();
  const mainFlower = String(body?.mainFlower ?? "").trim();
  const mainFlowerKey = String(body?.mainFlowerKey ?? "").trim();
  const rawCautions = Array.isArray(body?.cautions) ? body.cautions : [];

  const styleLabelMap = {
    soft_feminine: "청순/여리",
    romantic: "러블리",
    chic_elegant: "세련/우아",
    trendy: "트렌디/힙",
    minimal: "미니멀/깔끔",
  };
  const photoHabitLabelMap = {
    sns_often: "SNS 자주 올림",
    sns_sometimes: "가끔 올림",
    private_photo: "찍고 보관",
    no_photo: "사진 관심 없음",
  };
  const cautionLabelMap = {
    scent_light: "향은 약한 쪽",
    allergy_sensitive: "알레르기/민감",
    no_rose: "장미 제외",
    clean_over_flashy: "화려함보다 깔끔",
    none: "없음",
  };

  const styleLabel = styleLabelMap[styleKey] || "세련/우아";
  const photoHabitLabel = photoHabitLabelMap[photoHabitKey] || "가끔 올림";

  const cautionsShort = rawCautions
    .map((v) => cautionLabelMap[v] || String(v))
    .filter((v) => v && v !== "없음" && v !== "none")
    .slice(0, 4);

  const paletteMeta = paletteMap[paletteKey] || {
    label: "내추럴",
    colors: [
      { hex: "#EDE7DF", name: "Oat" },
      { hex: "#D2C4B2", name: "Sand" },
      { hex: "#A9B8A0", name: "Moss" },
    ],
  };

  // ✅ 포장 가이드: Q6 + 팔레트 + 스타일 반영
  const wrapByPhoto = {
    sns_often: "포인트 컬러 포장 + 리본 포인트(사진발 우선)",
    sns_sometimes: "톤다운 포장 + 리본 1개(무난하고 예쁘게)",
    private_photo: "무광/차분 포장 + 리본 최소(깔끔하게)",
    no_photo: "크래프트/심플 포장 + 리본 최소(담백하게)",
  };
  const wrapToneByPalette = {
    white_green: "화이트/오프화이트 포장지(무광) + 그린 포인트",
    pink_peach: "오프화이트/연핑크 포장지 + 얇은 리본",
    lilac: "오프화이트/연보라 포장지 + 톤다운 리본",
    red_wine: "오프화이트/크림 포장지 + 버건디 리본(과하지 않게)",
    yellow_orange: "오프화이트/크림 포장지 + 옐로 포인트(절제)",
  };
  const wrapFinishByStyle = {
    soft_feminine: "부드러운 레이어 1장(과장 금지)",
    romantic: "리본은 얇게(톤온톤), 과한 프릴 금지",
    chic_elegant: "무광 종이 + 각 잡힌 마감(정돈)",
    trendy: "포인트는 한 색만(과함 금지)",
    minimal: "장식 최소, 리본 0~1개",
  };

  const wrapGuide = [
    wrapByPhoto[photoHabitKey] || wrapByPhoto.sns_sometimes,
    wrapToneByPalette[paletteKey] || "오프화이트/크림 계열 포장지",
    wrapFinishByStyle[styleKey] || "무광 종이 + 정돈된 마감",
  ].join(" / ");

  // ✅ 가격 추천(상황/관계/사진습관 반영)
  function recommendBudgetAndSize() {
    const relation = relationRaw;
    const occasion = occasionRaw;

    let size = "M";
    let budget = "약 5만 ~ 8만 원";
    let reason = "대부분 상황에서 무난하고 실패 확률이 낮은 크기";

    const isSome = relation.includes("썸") || relation.includes("소개팅");
    const isPartner = relation.includes("여자친구") || relation.includes("연인");
    const isSpouse = relation.includes("아내") || relation.includes("배우자");
    const isFriendCoworker = relation.includes("친구") || relation.includes("동료");

    const isBday = occasion.includes("생일") || occasion.includes("기념일");
    const isCongrats =
      occasion.includes("축하") ||
      occasion.includes("합격") ||
      occasion.includes("승진") ||
      occasion.includes("새출발");
    const isSorry = occasion.includes("미안") || occasion.includes("사과");
    const isFirst = occasion.includes("처음");

    if (isSome || isSorry || isFirst) {
      size = "S";
      budget = "약 3만 ~ 5만 원";
      reason = "부담 없이 주기 좋은 안전한 구간";
    }

    if (isFriendCoworker && isCongrats) {
      size = "M";
      budget = "약 5만 ~ 8만 원";
      reason = "축하 분위기 + 적당한 존재감";
    }

    if ((isPartner || isSpouse) && isBday) {
      size = "L";
      budget = "약 8만 ~ 13만 원";
      reason = "기념일은 ‘확실한 선물’ 느낌이 나야 만족도가 높음";
    }

    // SNS 자주면 한 단계 업(사진발)
    if (photoHabitKey === "sns_often") {
      if (size === "S") {
        size = "M";
        budget = "약 5만 ~ 8만 원";
        reason = "사진에 예쁘게 남기려면 볼륨이 필요";
      } else if (size === "M" && (isPartner || isSpouse || isBday)) {
        size = "L";
        budget = "약 8만 ~ 13만 원";
        reason = "SNS 업로드 시 ‘선물 값’이 보이게 나오는 구간";
      }
    }

    return {
      size,
      budget,
      reason,
      table: {
        S: "3만~5만 (가벼운 감사/첫 선물/사과)",
        M: "5만~8만 (친한 친구/축하/무난)",
        L: "8만~13만 (각별한 사이/기념일)",
      },
    };
  }

  const priceRec = recommendBudgetAndSize();
  function sizeSpecByBudget(size) {
    const s = String(size || "M").toUpperCase();

    if (s === "S") {
      return {
        size: "S",
        label: "mini / compact",
        // ✅ 실물 기준 (대략)
        overallCm: "height 28–33cm, width 18–22cm",
        wrapScale: "small wrap, narrow paper width, minimal layers",
        ribbonScale: "small ribbon (thin, short tails)",
        stemExpose: "short stem exposure (neat bottom)",
        stemsTotal: [6, 10],
        focalCount: [1, 2], // ✅ S는 포컬 1~2로 확 줄이기
        secondaryCount: [2, 4],
        fillerCount: [0, 1],
        greeneryCount: [1, 1],
        costRatio: { focal: 0.45, secondary: 0.4, fillerGreen: 0.15 },
      };
    }

    if (s === "L") {
      return {
        size: "L",
        label: "large / abundant",
        overallCm: "height 45–55cm, width 32–40cm",
        wrapScale: "wide layered wrap, fuller silhouette",
        ribbonScale: "medium ribbon (longer tails)",
        stemExpose: "longer stem exposure (premium finish)",
        stemsTotal: [22, 32],
        focalCount: [4, 6],
        secondaryCount: [10, 16],
        fillerCount: [1, 2],
        greeneryCount: [2, 3],
        costRatio: { focal: 0.35, secondary: 0.45, fillerGreen: 0.2 },
      };
    }

    // M default
    return {
      size: "M",
      label: "medium / balanced",
      overallCm: "height 38–45cm, width 26–32cm",
      wrapScale: "standard layered wrap, balanced silhouette",
      ribbonScale: "small-to-medium ribbon",
      stemExpose: "medium stem exposure",
      stemsTotal: [12, 18],
      focalCount: [3, 4],
      secondaryCount: [6, 10],
      fillerCount: [1, 1],
      greeneryCount: [1, 2],
      costRatio: { focal: 0.4, secondary: 0.42, fillerGreen: 0.18 },
    };
  }

  // 팔레트별 '소재 세트' (꽃집에서 통하는 표현 위주)
  // 포컬 = 가격대가 올라가는 핵심, 서브 = 볼륨 담당, 필러/그린 = 가성비/완성도
  const PALETTE_FLOWER_SET = {
    white_green: {
      focal: ["화이트 장미", "화이트 리시안셔스", "화이트 튤립", "카라(화이트)", "화이트 수국(소량)"],
      secondary: ["스프레이 장미(화이트/크림)", "리시안셔스(연크림)", "알스트로메리아(화이트)"],
      filler: ["왁스플라워(화이트)", "안개(소량)"],
      greenery: ["유칼립투스", "러스커스"],
      avoid: ["거베라", "데이지 느낌 1송이 단독", "너무 노란 필러"],
    },
    pink_peach: {
      focal: ["핑크 장미", "라넌큘러스(피치/핑크)", "리시안셔스(연핑크)", "튤립(연핑크)"],
      secondary: ["스프레이 장미(핑크)", "소형 카네이션(연핑크)", "알스트로메리아(연핑크/크림)"],
      filler: ["왁스플라워", "안개(소량)"],
      greenery: ["유칼립투스", "러스커스"],
      avoid: ["쨍한 푸시아 단독", "과한 프릴 포장"],
    },
    lilac: {
      focal: ["리시안셔스(연보라)", "수국(연보라/화이트, 소량)", "장미(연보라/라벤더)", "튤립(연보라)"],
      secondary: ["스프레이 장미(라벤더)", "알스트로메리아(연보라)", "리시안셔스(화이트 보강)"],
      filler: ["스타티스(연보라)", "왁스플라워"],
      greenery: ["유칼립투스", "러스커스"],
      avoid: ["진보라 한 색만 과다", "검정 포장 과다"],
    },
    red_wine: {
      focal: ["딥레드 장미", "라넌큘러스(버건디)", "카라(다크톤)", "카네이션(버건디/다크핑크)"],
      secondary: ["스프레이 장미(딥레드)", "소형 카네이션(버건디)", "리시안셔스(크림 보강)"],
      filler: ["히페리컴 베리(가능하면)", "왁스플라워(대체)"],
      greenery: ["러스커스", "유칼립투스"],
      avoid: ["빨강+검정 과다", "너무 번쩍이는 포장"],
    },
    yellow_orange: {
      focal: ["튤립(옐로/오렌지)", "거베라(1~2송이만)", "장미(옐로)", "라넌큘러스(옐로/살구)"],
      secondary: ["스프레이 장미(옐로)", "알스트로메리아(크림/옐로)", "리시안셔스(크림 보강)"],
      filler: ["솔리다고(소량)", "왁스플라워(대체)"],
      greenery: ["유칼립투스", "피토스포룸"],
      avoid: ["솔리다고 과다(촌스러움)", "쨍한 다색 혼합"],
    },
  };

  function pickBySize(list, countMinMax, seed = 0) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    if (arr.length === 0) return [];
    const [min, max] = countMinMax;
    const n = max === min ? min : min + (seed % (max - min + 1));
    // 간단 회전 선택(고정 랜덤처럼)
    const start = seed % arr.length;
    const rotated = arr.slice(start).concat(arr.slice(0, start));
    return rotated.slice(0, Math.min(n, arr.length));
  }

  function buildFlowerPlan({ paletteKey, sizeSpec, mainFlower, seedStr }) {
    const set = PALETTE_FLOWER_SET[paletteKey] || PALETTE_FLOWER_SET.white_green;
    const seed =
      typeof seedStr === "string" && seedStr.length
        ? [...seedStr].reduce((a, c) => a + c.charCodeAt(0), 0)
        : 7;

    // 포컬/서브/필러/그린을 "줄기 수"에 맞춰 구성
    const focalList = [...set.focal];
    if (mainFlower) {
      // 메인꽃은 포컬 리스트 맨 앞에 삽입(중복 방지)
      const mf = String(mainFlower).trim();
      if (mf) {
        const filtered = focalList.filter((x) => x !== mf);
        focalList.length = 0;
        focalList.push(mf, ...filtered);
      }
    }

    const focal = pickBySize(focalList, sizeSpec.focalCount, seed + 11);
    const secondary = pickBySize(set.secondary, sizeSpec.secondaryCount, seed + 23);
    const filler = pickBySize(set.filler, sizeSpec.fillerCount, seed + 37);
    const greenery = pickBySize(set.greenery, sizeSpec.greeneryCount, seed + 41);

    // "가성비" 문장(가격대별로 포컬 비율이 다름)
    const ratio = sizeSpec.costRatio;
    const ratioText = `구성 비율(대략): 포컬 ${Math.round(ratio.focal * 100)}% / 서브 ${Math.round(ratio.secondary * 100)}% / 필러·그린 ${Math.round(ratio.fillerGreen * 100)}%`;

    const stemsText = `줄기 수 가이드: 총 ${sizeSpec.stemsTotal[0]}~${sizeSpec.stemsTotal[1]}대 (포컬 ${sizeSpec.focalCount[0]}~${sizeSpec.focalCount[1]} / 서브 ${sizeSpec.secondaryCount[0]}~${sizeSpec.secondaryCount[1]} / 필러 ${sizeSpec.fillerCount[0]}~${sizeSpec.fillerCount[1]} / 그린 ${sizeSpec.greeneryCount[0]}~${sizeSpec.greeneryCount[1]})`;

    return {
      focal,
      secondary,
      filler,
      greenery,
      avoid: set.avoid || [],
      ratioText,
      stemsText,
      wrapDensity: sizeSpec.wrapScale,
    };
  }
  const sizeSpec = sizeSpecByBudget(priceRec.size);
  const planSeed = [
    relationRaw,
    occasionRaw,
    styleKey,
    paletteKey,
    photoHabitKey,
    (rawCautions || []).join(","),
  ].join("|");
  const flowerPlan = buildFlowerPlan({ paletteKey, sizeSpec, mainFlower, seedStr: planSeed });

  const flowerMix = [
    `포컬(메인급): ${flowerPlan.focal.join(" · ") || "시즌 포컬 2종"}`,
    `서브(볼륨): ${flowerPlan.secondary.join(" · ") || "스프레이/톤맞춤 꽃"}`,
    `필러: ${flowerPlan.filler.join(" · ") || "소량"}`,
    `그린: ${flowerPlan.greenery.join(" · ") || "유칼립/러스커스"}`,
    flowerPlan.stemsText,
    flowerPlan.ratioText,
    `피하기: ${flowerPlan.avoid.slice(0, 3).join(" · ") || "과한 1송이 중심"}`,
    "대체 규칙: 재고 없으면 ‘같은 톤/같은 무드’의 시즌 꽃으로 대체(색/결 유지)",
  ].join("\n");

  // ✅ 멘트 5개(상황 반영)
  function buildMessages() {
    const who = relationRaw;
    const occasion = occasionRaw;

    const base = [
      `${who} 생각나서 이 느낌으로 골라봤어.`,
      `부담 없이 받아줘. ${who}한테 잘 어울릴 것 같았어.`,
      `오늘은 ${who} 기분 좋아졌으면 해서 준비했어.`,
      `${occasion}이라 그냥 지나치기 싫었어.`,
      "꽃처럼 예쁜 하루 보내 🙂",
    ];

    if (occasion.includes("미안") || occasion.includes("사과")) {
      base[0] = "미안해. 말로만 하지 않고 진심으로 전하고 싶었어.";
      base[3] = "내가 더 잘할게. 오늘은 마음 풀렸으면 좋겠다.";
    }
    if (occasion.includes("축하") || occasion.includes("합격") || occasion.includes("승진")) {
      base[2] = "진짜 멋졌다. 이렇게 축하하고 싶었어.";
    }

    return base;
  }

  const messages = buildMessages();

  // ✅ 무드 라벨(남성용 이해 쉬운 태그)
  function buildMoodLabel() {
    const paletteTag = {
      white_green: "깔끔/정돈/미니멀",
      pink_peach: "부드러움/러블리/호감",
      lilac: "차분/감성/세련",
      red_wine: "로맨틱/포인트/확실",
      yellow_orange: "밝음/활기/응원",
    }[paletteKey] || "내추럴";

    const styleTag = {
      soft_feminine: "맑고 여리한",
      romantic: "달콤하고 사랑스러운",
      chic_elegant: "도시적이고 정돈된",
      trendy: "감각적이고 쿨한",
      minimal: "담백하고 절제된",
    }[styleKey] || "정돈된";

    return `${styleTag} / ${paletteTag}`;
  }

  const moodLabel = `${paletteMeta.label} · ${buildMoodLabel()}`;

  const cautionLine = cautionsShort.length
    ? `주의: ${cautionsShort.join(" · ")}`
    : "주의: 너무 화려하지 않게, 과하지 않게";

  // ✅ 꽃집 복붙 주문서(불안 해소용)
  const orderText = [
    `[예산/사이즈] ${priceRec.size} / ${priceRec.budget} (이유: ${priceRec.reason})`,
    `[상황] ${relationRaw}에게 ${occasionRaw} 선물`,
    `[메인 꽃] ${mainFlower ? `"${mainFlower}" 꼭 포함` : "꽃집 추천 메인꽃 1종 중심"}`,
    `[무드/색] ${moodLabel} / ${paletteMeta.label} 톤 중심`,
    `[포장] ${wrapGuide}`,
    `[사진] ${photoHabitLabel} → 사진에 디테일이 잘 보이게 정돈`,
    `[볼륨/줄기수] ${flowerPlan.stemsText}`,
    `[비율] ${flowerPlan.ratioText}`,
    `[피하기] ${flowerPlan.avoid.slice(0, 3).join(" · ") || "한 송이만 크게/과한 크롭"}`,
    `[구성] 포컬 ${sizeSpec.focalCount[0]}~${sizeSpec.focalCount[1]}송이(비슷한 크기) + 서브로 볼륨, 필러/그린은 과하지 않게`,
    `[대체] 재고 없으면 같은 톤/무드로 대체(톤 유지)`,
    cautionLine,
  ].join("\n");

  // ✅ 이미지 프롬프트(Q값 반영)
  const paletteLine = (paletteMeta.colors || [])
    .map((c) => `${c.name} (${c.hex})`)
    .join(", ");
  const focalRuleLine =
    sizeSpec.size === "S"
      ? "Show 1–2 focal blooms clearly visible from the front (small bouquet), no oversized hero bloom."
      : "Show THREE focal blooms clearly visible from the front, similar size, arranged in a triangular composition.";
  const qualityTone =
    sizeSpec.size === "S"
      ? "clean, realistic, simple florist look (not abundant)."
      : "premium florist finish, high realism, abundant but balanced.";

  const imagePrompt = [
    "Photorealistic studio product photo of a Korean florist hand-tied bouquet (premium realistic).",
    "Full bouquet visible from top to bottom, INCLUDING ribbon and bottom wrap. Do NOT crop.",
    "Centered composition with generous negative space (leave 15–25% empty margin on all sides).",
    "Seamless light gray / warm off-white backdrop with subtle gradient, softbox lighting, natural soft shadow.",
    "NO people, NO hands, NO text, NO watermark, NO logo.",

    // ✅ 한 송이 'dominant' 금지: 포컬 3송이 규칙
    "Balanced multi-flower bouquet (NOT a single oversized centerpiece):",
    `Bouquet overall size (realistic): ${sizeSpec.overallCm}.`,
    `Wrap scale: ${sizeSpec.wrapScale}. Ribbon scale: ${sizeSpec.ribbonScale}. ${sizeSpec.stemExpose}.`,
    `Stem count guide: total ${sizeSpec.stemsTotal[0]}–${sizeSpec.stemsTotal[1]} stems.`,
    `Focal count: ${sizeSpec.focalCount[0]}–${sizeSpec.focalCount[1]} focal blooms; secondary ${sizeSpec.secondaryCount[0]}–${sizeSpec.secondaryCount[1]}; filler ${sizeSpec.fillerCount[0]}–${sizeSpec.fillerCount[1]}; greenery ${sizeSpec.greeneryCount[0]}–${sizeSpec.greeneryCount[1]}.`,
    `Volume rule: ${flowerPlan.ratioText}.`,
    `Avoid: ${flowerPlan.avoid.slice(0, 3).join(", ")}.`,
    focalRuleLine,
    "Add 6–10 secondary blooms + 1 filler flower + 1–2 airy greenery types for volume and depth.",
    "Avoid: single flower bouquet, one giant hero bloom, tight crop, bouquet cut off at bottom.",

    // ✅ 메인꽃은 'dominant'가 아니라 '포컬 중 하나'
    mainFlower
      ? `Include "${mainFlower}" as ONE of the 3 focal blooms (medium size), clearly visible but NOT oversized.`
      : "Ensure 3 focal blooms are clearly visible (none oversized).",

    `Color palette: ${paletteMeta.label}. Use these colors: ${paletteLine}.`,
    `Style/mood: ${styleLabel}.`,
    `Focal flowers: ${flowerPlan.focal.join(" + ")}.`,
    `Secondary flowers: ${flowerPlan.secondary.slice(0, 3).join(" + ")}.`,
    `Greenery: ${flowerPlan.greenery.join(" + ")}.`,

    // 포장 지시는 간결하게 (wrapGuide가 길면 산만해져서)
    "Wrapping: matte paper wrap, clean layered finish, one satin ribbon, not flashy.",

    "Real paper wrap with subtle wrinkles and micro texture, premium florist finish.",
    "Natural petals and realistic greenery, slight asymmetry, layered depth, high realism.",
    qualityTone,

    cautionsShort.includes("알레르기/민감")
      ? "Keep clean petals; avoid pollen-heavy look; minimize dusty filler."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  // ✅ 이미지 생성(실패해도 로컬 이미지로 무조건 fallback)
  let imageUrl = "";
  let imageSource = "fallback";
  let imageError = "";
  try {
    const apiKey = env?.OPENAI_API_KEY;
    if (!apiKey) {
      imageError = "missing_openai_api_key";
    } else {
      imageUrl = await generateBouquetImageBase64({ apiKey, prompt: imagePrompt });
      if (imageUrl) imageSource = "openai";
    }
  } catch (err) {
    imageError = String(err?.message || "image_generation_unknown_error");
  }
  if (!imageUrl) {
    imageUrl = flowerImgByKey[mainFlowerKey] || "/image/rose.png";
  }

  const meaning = (() => {
    if (mainFlower.includes("장미")) return "호감/애정 표현에 무난한 선택";
    if (mainFlower.includes("카네이션")) return "감사/존중을 담기 쉬운 선택";
    if (mainFlower.includes("튤립")) return "깔끔하고 설레는 분위기를 만들기 쉬움";
    if (mainFlower.includes("수국")) return "볼륨감과 사진발에 유리";
    if (mainFlower.includes("카라") || mainFlower.includes("칼라")) return "세련되고 도시적인 인상";
    if (mainFlower.includes("거베라")) return "밝고 기분 좋은 무드";
    if (mainFlower.includes("라넌")) return "러블리/풍성한 무드";
    if (mainFlower.includes("리시안")) return "정돈되고 고급스러운 무드";
    return "선물로 무난한 무드";
  })();

  return {
    __build: "GUIDE-V2.1",
    imageSource,
    imageError,
    mainFlower,
    imageUrl,
    targetName: relationRaw,
    moodLabel,
    orderText,
    wrapGuide,
    flowerMix,
    palettes: paletteMeta.colors,
    messages,
    priceInfo: `${priceRec.size} 기준 ${priceRec.budget}`,
    recommend: {
      size: priceRec.size,
      budget: priceRec.budget,
      reason: priceRec.reason,
    },
    priceTable: priceRec.table,
    meaning,
  };
}
