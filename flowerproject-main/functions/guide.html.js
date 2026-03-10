function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function timingSafeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;

  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  for (const cookie of cookies) {
    if (!cookie) continue;
    const [key, ...rest] = cookie.split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ""));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function loginPage(errorMessage = "") {
  const errorHtml = errorMessage
    ? `<p class="error">${errorMessage}</p>`
    : '<p class="hint">관리자 비밀번호를 입력해야 접근할 수 있습니다.</p>';

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Lock</title>
  <style>
    :root {
      --bg: #f6f3ed;
      --card: #ffffff;
      --line: #e7dfd1;
      --text: #1e293b;
      --muted: #64748b;
      --accent: #2d9a57;
      --accent-dark: #257d47;
      --error: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background:
        radial-gradient(circle at top, #fffaf3 0%, var(--bg) 55%),
        linear-gradient(135deg, #f8f5ef 0%, #efe7db 100%);
      color: var(--text);
      font-family: "Noto Sans KR", "Apple SD Gothic Neo", sans-serif;
    }
    .card {
      width: min(100%, 420px);
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
      padding: 28px;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      padding: 7px 10px;
      border-radius: 999px;
      background: #edf8f1;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    h1 {
      margin: 14px 0 8px;
      font-size: 24px;
      line-height: 1.3;
    }
    p {
      margin: 0 0 14px;
      font-size: 14px;
      color: var(--muted);
    }
    .error {
      color: var(--error);
      font-weight: 700;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 13px;
      font-weight: 700;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 15px;
      outline: none;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(61, 181, 106, 0.12);
    }
    button {
      width: 100%;
      margin-top: 14px;
      border: 0;
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 15px;
      font-weight: 800;
      color: #fff;
      background: var(--accent);
      cursor: pointer;
    }
    button:hover {
      background: var(--accent-dark);
    }
    .foot {
      margin-top: 12px;
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="eyebrow">ADMIN ONLY</div>
    <h1>어드민 페이지 잠금</h1>
    ${errorHtml}
    <form method="post">
      <label for="password">비밀번호</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">들어가기</button>
    </form>
    <div class="foot">환경변수 <code>ADMIN_PASSWORD</code> 를 배포 환경에 설정해야 합니다.</div>
  </main>
</body>
</html>`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const expectedPassword = String(env?.ADMIN_PASSWORD || "").trim();

  if (!expectedPassword) {
    return html(loginPage("ADMIN_PASSWORD 환경변수가 설정되지 않았습니다."), 500);
  }

  if (url.searchParams.get("logout") === "1") {
    return html(loginPage("로그아웃되었습니다."), 200, {
      "Set-Cookie":
        "admin_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    });
  }

  const expectedToken = await sha256Hex(expectedPassword);
  const savedToken = decodeURIComponent(getCookie(request, "admin_auth") || "");
  if (request.method === "GET" && timingSafeEqual(savedToken, expectedToken)) {
    return context.next();
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const password = String(form.get("password") || "");

    if (timingSafeEqual(password, expectedPassword)) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/guide.html",
          "Cache-Control": "no-store",
          "Set-Cookie": `admin_auth=${encodeURIComponent(expectedToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`,
        },
      });
    }

    return html(loginPage("비밀번호가 일치하지 않습니다."), 401);
  }

  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "GET, POST" },
  });
}
