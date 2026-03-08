#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   BASE_URL="https://your-site.example.com" ./scripts/check_pro_api.sh

BASE_URL="${BASE_URL:-}"
if [[ -z "$BASE_URL" ]]; then
  echo "BASE_URL is required. Example:"
  echo '  BASE_URL="https://your-site.example.com" ./scripts/check_pro_api.sh'
  exit 1
fi

API_URL="${BASE_URL%/}/api/pro"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass_count=0
fail_count=0

report() {
  local name="$1"
  local got="$2"
  local expected="$3"
  local body_file="$4"
  if [[ "$got" == "$expected" ]]; then
    echo "PASS ${name}: got=${got} expected=${expected}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL ${name}: got=${got} expected=${expected}"
    echo "  body: $(cat "$body_file")"
    fail_count=$((fail_count + 1))
  fi
}

echo "Target: ${API_URL}"

# 1) 200: 정상 응답
status_200="$(
  curl -sS -o "${TMP_DIR}/200.json" -w "%{http_code}" \
    -X POST "${API_URL}" \
    -H "Content-Type: application/json" \
    --data '{"prompt":"smoke test"}'
)"
report "200_success" "$status_200" "200" "${TMP_DIR}/200.json"

# 2) 403: 외부 Origin 차단
status_403="$(
  curl -sS -o "${TMP_DIR}/403.json" -w "%{http_code}" \
    -X POST "${API_URL}" \
    -H "Content-Type: application/json" \
    -H "Origin: https://evil.example.com" \
    --data '{"prompt":"forbidden origin test"}'
)"
report "403_forbidden_origin" "$status_403" "403" "${TMP_DIR}/403.json"

# 3) 연속 호출: 동일 클라이언트 반복 호출도 정상 응답(200)이어야 함
for i in $(seq 1 5); do
  code="$(
    curl -sS -o "${TMP_DIR}/repeat_${i}.json" -w "%{http_code}" \
      -X POST "${API_URL}" \
      -H "Content-Type: application/json" \
      -H "CF-Connecting-IP: 9.9.9.9" \
      -H "X-Forwarded-For: 9.9.9.9" \
      --data "{\"prompt\":\"repeat request test ${i}\"}"
  )"
  report "200_repeat_${i}" "$code" "200" "${TMP_DIR}/repeat_${i}.json"
done

echo
echo "504_upstream_timeout check:"
echo "- Current implementation times out when upstream OpenAI call exceeds 20s."
echo "- This cannot be reliably forced via public curl alone."
echo "- Validate by temporarily simulating upstream delay/failure in staging, then expect HTTP 504 with {\"error\":\"upstream_timeout\"}."

echo
echo "Summary: pass=${pass_count}, fail=${fail_count}"
if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
