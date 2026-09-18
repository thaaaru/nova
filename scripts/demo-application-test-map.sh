#!/usr/bin/env bash
# End-to-end demo of the Application Test Map against the seeded sample
# e-commerce map (fixtures/sample-application-test-map.ts) — no real target
# application required. Every command below is a real `nova` invocation
# against a scratch database; nothing here is a mock or a dry run.
#
# Usage: ./scripts/demo-application-test-map.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DEMO_DIR="$(mktemp -d)"
export NOVA_DATABASE_PATH="$DEMO_DIR/data/nova.sqlite"
export NOVA_ARTIFACTS_DIR="$DEMO_DIR/artifacts"

echo "== Seeding the sample Application Test Map =="
SEED_SCRIPT="./demo-seed-script.mts"
trap 'rm -rf "$DEMO_DIR" "$SEED_SCRIPT"' EXIT
cat >"$SEED_SCRIPT" <<'EOF'
import { buildRuntime } from "./src/cli/context.ts";
import { sampleApplicationTestMap } from "./fixtures/sample-application-test-map.ts";

const runtime = buildRuntime();
runtime.testMaps.save(sampleApplicationTestMap);
console.log(`Seeded ${sampleApplicationTestMap.id} (${sampleApplicationTestMap.applicationName}).`);
EOF
pnpm exec tsx "$SEED_SCRIPT"
rm -f "$SEED_SCRIPT"

MAP_ID="map-shop-staging-ecommerce-v1"
NOVA="pnpm exec tsx src/cli/index.ts"

echo
echo "== nova map list =="
$NOVA map list

echo
echo "== nova area list --map $MAP_ID =="
$NOVA area list --map "$MAP_ID"

echo
echo "== nova journey list --map $MAP_ID --area checkout =="
$NOVA journey list --map "$MAP_ID" --area checkout

echo
echo "== nova recommendations --map $MAP_ID =="
$NOVA recommendations --map "$MAP_ID"

echo
echo "== nova journey describe (natural-language test creation) =="
$NOVA journey describe "$MAP_ID" "Test coupon handling when a registered customer checks out"

echo
echo "== nova journey run coupon_discount_calculation (quick_test — runs immediately) =="
$NOVA journey run coupon_discount_calculation \
  --map "$MAP_ID" --env staging \
  --fixture in-stock-product --fixture valid-coupon-code

echo
echo "== nova journey run registered_customer_checkout (controlled_test — stages for approval) =="
RUN_OUTPUT="$($NOVA journey run registered_customer_checkout \
  --map "$MAP_ID" --env staging --persona standard_customer \
  --fixture in-stock-product --fixture sandbox-payment-card)"
echo "$RUN_OUTPUT"
RUN_ID="$(echo "$RUN_OUTPUT" | head -n1 | awk '{print $2}')"

echo
echo "== nova journey confirm $RUN_ID (the required human approval step) =="
$NOVA journey confirm "$RUN_ID" --reviewer "qa-lead"

echo
echo "== nova journey list --map $MAP_ID --area checkout (outcomes now recorded) =="
$NOVA journey list --map "$MAP_ID" --area checkout

echo
echo "Demo complete. Both journey runs above end 'failed' because"
echo "shop.staging.example.test is a fictional domain with nothing actually"
echo "listening — every governance mechanic still ran for real: scope"
echo "validation, fixture locking/cleanup, the controlled_test approval gate,"
echo "and journey outcome recording all happened against a real SQLite"
echo "database and a real (network-failing) Playwright execution, not a mock."
echo "Point --target/the map's approvedScope.allowedDomains at a real"
echo "application to see passing runs."
echo "Scratch database and artifacts were written under $DEMO_DIR and are removed on exit."
