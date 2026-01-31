#!/bin/bash

# Test script for postmark-service in production
# Usage: POSTMARK_SERVICE_API_KEY=xxx ./scripts/test-prod.sh

BASE_URL="https://postmark.mcpfactory.org"
API_KEY="${POSTMARK_SERVICE_API_KEY:-}"

if [ -z "$API_KEY" ]; then
  echo "Error: POSTMARK_SERVICE_API_KEY is required"
  echo "Usage: POSTMARK_SERVICE_API_KEY=xxx ./scripts/test-prod.sh"
  exit 1
fi

echo "=== Testing postmark-service ==="
echo "URL: $BASE_URL"
echo ""

# Test 1: Health check (no auth required)
echo "1. Health check..."
HEALTH=$(curl -s "$BASE_URL/health")
echo "   Response: $HEALTH"
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "   ✅ Health check passed"
else
  echo "   ❌ Health check failed"
  exit 1
fi
echo ""

# Test 2: Auth check (should fail without key)
echo "2. Auth check (without key)..."
AUTH_FAIL=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/status/test-id")
if [ "$AUTH_FAIL" = "401" ]; then
  echo "   ✅ Correctly rejected (401)"
else
  echo "   ❌ Expected 401, got $AUTH_FAIL"
fi
echo ""

# Test 3: Auth check (with key)
echo "3. Auth check (with key)..."
AUTH_OK=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "X-API-Key: $API_KEY" \
  "$BASE_URL/status/00000000-0000-0000-0000-000000000000")
if [ "$AUTH_OK" = "404" ]; then
  echo "   ✅ Auth passed (404 = message not found, expected)"
else
  echo "   ❌ Expected 404, got $AUTH_OK"
fi
echo ""

# Test 4: Webhook endpoint (no auth required)
echo "4. Webhook endpoint..."
WEBHOOK=$(curl -s -X POST "$BASE_URL/webhooks/postmark" \
  -H "Content-Type: application/json" \
  -d '{"RecordType": "Test"}')
echo "   Response: $WEBHOOK"
echo ""

echo "=== Tests complete ==="
