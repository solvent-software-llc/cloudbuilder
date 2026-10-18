#!/usr/bin/env bash
# Reads or flips an API stack's maintenance switch: which integration its
# $default route targets (src/api.ts). Used by api-maintenance.yml (on/off)
# and api-deploy.yml (status, passed to `cdk deploy` as API_MAINTENANCE so the
# deploy matches the live route instead of resetting it).
#
#   STACK=<api stack name> bin/api-maintenance.sh status|on|off
#
# Prints "on" or "off" (the resulting state) on stdout. The route's own target
# is the only state — there's no separate flag to drift from what the API is
# actually serving. A route change takes effect within seconds: the $default
# stage auto-deploys.
set -euo pipefail

action="${1:-}"
if [[ "$action" != status && "$action" != on && "$action" != off ]]; then
    echo "usage: STACK=<api stack name> $0 status|on|off" >&2
    exit 2
fi
: "${STACK:?STACK is required}"

err=$(mktemp)
trap 'rm -f "$err"' EXIT

if ! outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[0].Outputs' --output json 2>"$err"); then
    if grep -q "does not exist" "$err" && [[ "$action" == status ]]; then
        # First deploy: no API yet, so nothing is in maintenance.
        echo off
        exit 0
    fi
    cat "$err" >&2
    exit 1
fi

output() {
    jq -r --arg key "$1" '(. // [])[] | select(.OutputKey == $key) | .OutputValue' <<<"$outputs"
}
api_id=$(output HttpApiId)
route_id=$(output DefaultRouteId)
function_integration=$(output FunctionIntegrationId)
maintenance_integration=$(output MaintenanceIntegrationId)

if [[ -z "$maintenance_integration" ]]; then
    if [[ "$action" == status ]]; then
        # Deployed before maintenance mode existed, so it can't be on.
        echo off
        exit 0
    fi
    echo "stack $STACK predates maintenance mode; deploy it once with api-deploy.yml first" >&2
    exit 1
fi

if [[ "$action" != status ]]; then
    if [[ "$action" == on ]]; then
        target="integrations/$maintenance_integration"
    else
        target="integrations/$function_integration"
    fi
    aws apigatewayv2 update-route --api-id "$api_id" --route-id "$route_id" \
        --target "$target" >/dev/null
fi

current=$(aws apigatewayv2 get-route --api-id "$api_id" --route-id "$route_id" \
    --query Target --output text)
case "$current" in
    "integrations/$maintenance_integration") echo on ;;
    "integrations/$function_integration") echo off ;;
    *)
        echo "route $route_id targets $current, which is neither the function's nor the maintenance integration" >&2
        exit 1
        ;;
esac
