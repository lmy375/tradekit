#!/usr/bin/env bash
# tradekit smoke test — exercises the read-only critical paths and a simulated trade.
# Intended to be safe to run against the live test wallet: it never sends a real tx.
#
# Usage:
#   pnpm build && WALLET_PASS=<your-password> bash scripts/smoke.sh
#
# Exits 0 if all checks pass, non-zero otherwise.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$REPO_ROOT/dist/index.js"

if [ ! -x "$BIN" ]; then
  echo "FAIL: $BIN not found or not executable. Run \`pnpm build\` first."
  exit 2
fi
if [ -z "${WALLET_PASS:-}" ]; then
  echo "FAIL: WALLET_PASS env var is required."
  exit 2
fi

CHAIN="${CHAIN:-base}"
pass=0; fail=0
log() { printf "%-50s " "$1"; }
ok()  { echo "ok"; pass=$((pass+1)); }
ko()  { echo "FAIL: $1"; fail=$((fail+1)); }

# 1) version / help
log "[1] help renders"
"$BIN" help >/dev/null 2>&1 && ok || ko "exit code"

# 2) chains lists 6
log "[2] chains lists ethereum/base/arbitrum/optimism/bnb/polygon"
out="$("$BIN" chains 2>&1)"
for c in ethereum base arbitrum optimism bnb polygon; do
  if ! echo "$out" | grep -q "$c"; then ko "chain $c missing"; fi
done
echo "$out" | grep -q "Active chain:" && ok || ko "no Active chain header"

# 3) config show parses
log "[3] config show is valid JSON"
"$BIN" config show 2>/dev/null | python3 -c "import sys, json; json.load(sys.stdin)" \
  && ok || ko "config show not valid JSON"

# 4) wallet view (no password needed for public reads)
log "[4] wallet view on $CHAIN"
"$BIN" wallet view --chain "$CHAIN" >/dev/null 2>&1 && ok || ko "wallet view failed"

# 4a) Iter510: wallet view --json's `account` field is always a non-null string post
# iter505 (was `null` for keystore-only / orphan-HD pre-iter505). Pin so a future
# refactor that flips back to null-on-keystore breaks loudly. Also catches the
# regression where activeWalletLabel returns undefined.
log "[4a] iter510 wallet view --json account field is non-null string"
"$BIN" wallet view --chain "$CHAIN" --json 2>/dev/null | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert isinstance(d.get('account'), str), f'account not a string: {d.get(\"account\")!r}'
assert len(d['account']) > 0, f'account empty string: {d!r}'
" && ok || ko "iter510 wallet view --json account field unexpected shape"

# 5) holdings (no password)
log "[5] holdings on $CHAIN (json)"
"$BIN" holdings --chains "$CHAIN" --json 2>/dev/null \
  | python3 -c "import sys, json; d=json.load(sys.stdin); assert isinstance(d, list)" \
  && ok || ko "holdings json invalid"

# 6) trending (DexScreener public API)
# Iter424: pre-iter422 returned a bare list; iter422 wrapped with the {ok, query, chain,
# pairs, timestamp} envelope used by every other --json CLI command (iter375/377 family).
# Pin the envelope shape so a future refactor can't silently revert to a bare array.
log "[6] trending --limit 3 returns iter422 envelope"
"$BIN" trending --chain "$CHAIN" --limit 3 --json 2>/dev/null \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert isinstance(d, dict), f'expected envelope dict, got {type(d).__name__}'
assert d['ok'] is True, f'ok != True: {d}'
# query is null when no search term provided (the trending-on-chain path).
assert d['query'] is None, f'query should be null on trending-on-chain: {d.get(\"query\")}'
assert d['chain'], 'chain missing'
assert isinstance(d['pairs'], list), 'pairs should be a list'
assert d['timestamp'], 'timestamp missing'
" \
  && ok || ko "trending json envelope invalid"

# 7) price command falls back to DexScreener when CoinGecko rate-limits
log "[7] price ETH on $CHAIN"
"$BIN" price ETH --chain "$CHAIN" 2>/dev/null | grep -q "Current:" && ok || ko "no current price"

# 7a) Iter448: price --json carries the ok envelope + iter238 timestamp
# Splits from smoke 7's text-mode check because the JSON path skips the history blob
# (intentional in iter238's CLI surface) and emits a different shape. Pinning the
# envelope here catches a regression on either ok (iter448) or the timestamp field.
log "[7a] iter448 price --json envelope"
out="$("$BIN" price ETH --chain "$CHAIN" --json 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d.get('ok') is True, f'iter448 ok field missing: {d}'
assert d.get('token'), f'token missing: {d}'
assert d.get('chain'), f'chain missing: {d}'
assert d.get('timestamp', '').startswith('2'), f'timestamp missing/malformed: {d}'
# priceUsd can be null (rate-limited / unsupported pair) — we don't require it.
" && ok || ko "price --json envelope unexpected: $out"

# 8) audit reads
log "[8] audit reads recent entries"
"$BIN" audit --limit 3 >/dev/null 2>&1 && ok || ko "audit failed"

# 9) trades reads
log "[9] trades --format csv produces canonical header (even if empty)"
out="$("$BIN" trades --format csv 2>/dev/null || true)"
# Iter459: actually verify the header line is present. Pre-iter459 just ran `ok`
# blindly — a regression that broke the CSV path (e.g., iter454's csvField swallowing
# the empty value, or a column rename) would have slipped through. Header is fixed
# in TRADE_COLUMNS (src/db.ts) so the smoke pins the canonical first row.
echo "$out" | head -1 | grep -qE '^id,timestamp,chain,account,direction,base_token,base_symbol,base_amount,' && ok || ko "csv header missing/malformed: $(echo "$out" | head -1)"

# 10) quote → simulate end-to-end
log "[10] quote sell 0.00005 ETH → USDC on $CHAIN"
result="$("$BIN" quote --chain "$CHAIN" --direction sell --base ETH --quote USDC --baseAmount 0.00005 --json 2>/dev/null)"
echo "$result" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d.get('aggregator'), 'no aggregator'
assert float(d.get('price', '0')) > 100, f'price suspicious: {d.get(\"price\")}'
" && ok || ko "quote output unexpected"

# 10a) Iter486: quote works without --pass / WALLET_PASS. Pre-iter486 every quote
# invocation prompted for the wallet password even though the simulate-only path
# never decrypts the keystore. Run in a subshell with WALLET_PASS explicitly cleared
# so the env var inherited from this script's top-level export doesn't mask the gap.
log "[10a] iter486 quote runs without WALLET_PASS"
result="$(env -u WALLET_PASS "$BIN" quote --chain "$CHAIN" --direction sell --base ETH --quote USDC --baseAmount 0.00005 --json 2>/dev/null </dev/null)"
echo "$result" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d.get('aggregator'), f'no aggregator (response: {d})'
assert float(d.get('price', '0')) > 100, f'price suspicious: {d.get(\"price\")}'
" && ok || ko "iter486 quote without WALLET_PASS failed: $result"

# 11) allowances (requires password — read-only over RPC)
log "[11] allowances on $CHAIN"
"$BIN" allowances --chain "$CHAIN" >/dev/null 2>&1 && ok || ko "allowances failed"

# 11a) Iter455: --slippage 0 rejected at the CLI boundary (matches schema's min:1).
# Pre-iter455 the CLI accepted 0 and the trade was guaranteed to revert at submit.
# No RPC roundtrip needed — boundary validation fails before loadWallet.
log "[11a] iter455 --slippage 0 → INVALID_PARAMS at boundary"
out="$("$BIN" trade buy --base ETH --quote USDC --quoteAmount 1 --slippage 0 --chain "$CHAIN" --simulate --json 2>/tmp/slip_err.json || true)"
err="$(cat /tmp/slip_err.json 2>/dev/null || echo "")"
if [ -z "$out" ] && echo "$err" | grep -q 'INVALID_PARAMS' && echo "$err" | grep -q 'slippage'; then
  ok
else
  ko "iter455 --slippage 0 not rejected at boundary: stdout=$out stderr=$err"
fi
rm -f /tmp/slip_err.json

# 12a) doctor health check
log "[12a] doctor reports 0 critical failures"
"$BIN" doctor >/tmp/doctor.out 2>&1 || true
if grep -qE "^[0-9]+ ok · [0-9]+ warn · 0 fail" /tmp/doctor.out; then ok; else ko "doctor reported failures"; cat /tmp/doctor.out; fi
rm -f /tmp/doctor.out

# 12a.1) iter847/iter900-908: doctor --summary is exactly one line + matches canonical schema
log "[12a.1] iter847 doctor --summary is single-line"
"$BIN" doctor --summary >/tmp/doctor.summary 2>&1 || true
line_count=$(wc -l < /tmp/doctor.summary | tr -d ' ')
if [ "$line_count" = "1" ] && grep -qE "tradekit doctor · " /tmp/doctor.summary; then
  ok
else
  ko "doctor --summary not single-line or missing prefix"; cat /tmp/doctor.summary
fi
rm -f /tmp/doctor.summary

# 12a.2) iter846/iter900/iter903: health --summary is single-line + prefix + canonical schema
# Tests the iter921-aligned format: `<badge>  tradekit health · <fields> · <timestamp> (<elapsed>)`
log "[12a.2] iter846 health --summary is single-line"
"$BIN" health --summary --chains "$CHAIN" >/tmp/health.summary 2>&1 || true
line_count=$(wc -l < /tmp/health.summary | tr -d ' ')
if [ "$line_count" = "1" ] && grep -qE "tradekit health · " /tmp/health.summary; then
  ok
else
  ko "health --summary not single-line or missing prefix"; cat /tmp/health.summary
fi
rm -f /tmp/health.summary

# 12a.3) iter847 verify --summary — single-line + prefix
log "[12a.3] iter847 verify --summary is single-line"
"$BIN" verify all --summary >/tmp/verify.summary 2>&1 || true
lc=$(wc -l < /tmp/verify.summary | tr -d ' ')
if [ "$lc" = "1" ] && grep -qE "tradekit verify · " /tmp/verify.summary; then ok; else ko "verify --summary not single-line or missing prefix"; cat /tmp/verify.summary; fi
rm -f /tmp/verify.summary

# 12a.4) iter848 reconcile --summary — single-line + prefix
log "[12a.4] iter848 reconcile --summary is single-line"
"$BIN" reconcile --summary --chain "$CHAIN" >/tmp/reconcile.summary 2>&1 || true
lc=$(wc -l < /tmp/reconcile.summary | tr -d ' ')
if [ "$lc" = "1" ] && grep -qE "tradekit reconcile · " /tmp/reconcile.summary; then ok; else ko "reconcile --summary not single-line or missing prefix"; cat /tmp/reconcile.summary; fi
rm -f /tmp/reconcile.summary

# 12a.5) iter899 pending --summary — single-line + prefix
log "[12a.5] iter899 pending --summary is single-line"
"$BIN" pending --summary --chain "$CHAIN" >/tmp/pending.summary 2>&1 || true
lc=$(wc -l < /tmp/pending.summary | tr -d ' ')
if [ "$lc" = "1" ] && grep -qE "tradekit pending · " /tmp/pending.summary; then ok; else ko "pending --summary not single-line or missing prefix"; cat /tmp/pending.summary; fi
rm -f /tmp/pending.summary

# 12b) safety blocks infinite approve
log "[12b] infinite approve to known router blocked unless overridden"
out="$("$BIN" approve USDC 0x2626664c2603336E57B271c5C0b26F421741e481 --infinite --chain "$CHAIN" --json 2>&1 || true)"
echo "$out" | grep -q "SAFEGUARD_TRIGGERED" && ok || ko "safety did not trigger"

# 12c) version command
log "[12c] version prints tradekit + node"
"$BIN" version 2>&1 | grep -qE "tradekit [0-9]+\.[0-9]+" && ok || ko "version output unexpected"

# 12c.1) iter886: version --json has ok:true envelope (regression guard)
log "[12c.1] iter886 version --json envelope"
out="$("$BIN" version --json 2>&1 || true)"
if [ -z "$out" ] || ! echo "$out" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d.get('ok') is True, f'iter886 ok field missing: {d}'
assert d.get('tradekit'), f'tradekit field missing: {d}'
assert d.get('node'), f'node field missing: {d}'
" 2>/dev/null; then
  ko "iter886 version --json envelope unexpected"
else ok; fi

# 12c.2) iter862/iter924: tradekit --json (no args) returns install-status with account label
log "[12c.2] iter862/924 tradekit --json install-status envelope"
out="$("$BIN" --json 2>&1 || true)"
if [ -z "$out" ] || ! echo "$out" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'ok' in d, f'ok field missing: {d}'
assert 'version' in d, f'version missing: {d}'
assert 'activeChain' in d, f'activeChain missing: {d}'
assert 'needsInit' in d, f'needsInit missing: {d}'
assert 'account' in d, f'iter924 account field missing: {d}'
" 2>/dev/null; then
  ko "iter862/924 --json install-status envelope unexpected"
else ok; fi

# 12d) audit filters
# Layout (post-iter203): timestamp(1) status(2) caller(3) tool(4) chain(5) account(6).
# Test uses --json so it stays agnostic to the human-format column order.
log "[12d] audit --tool returns only that tool"
out="$("$BIN" audit --tool quote --limit 5 --json 2>&1 || true)"
if [ -z "$out" ] || ! echo "$out" | python3 -c "import sys, json; rows=json.load(sys.stdin); assert all(r.get('tool')=='quote' for r in rows), rows" 2>/dev/null; then
  ko "audit --tool returned non-quote rows"
else ok; fi

# 12e) audit prune is a no-op when no rows match
# Post-iter119 the message format is "Nothing to prune (no audit entries before X)."
# rather than "Pruned 0" — the iter119 preview short-circuits before the DELETE runs.
log "[12e] audit prune with old date is a no-op"
"$BIN" audit prune --before 2020-01-01 2>&1 | grep -qE "Nothing to prune|Pruned 0" && ok || ko "audit prune did not zero-prune"

# 12f) viewTx decodes a known Base swap
log "[12f] viewTx decodes a known Base swap"
# A canonical recent swap via KyberSwap MetaAggregationRouter (USDC → LITEFOLD). The
# specific hash can age out; the smoke gracefully accepts either a non-zero summary
# or a "Transaction not found" (we only verify the JSON path doesn't crash).
"$BIN" viewTx 0x3e2a443fe7d922bf8ccb0b783c41f3ffbc0b07c7c10cbfc24bdb286b1808605d --chain base --json 2>&1 \
  | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    # Either status:success with moves, or an error code (e.g. TX_NOT_FOUND if pruned).
    assert d.get('status') in ('success','failed','pending') or d.get('error'), 'unexpected shape'
except Exception as e:
    sys.exit(1)
" && ok || ko "viewTx didn't return a parseable shape"

# 12g) gas snapshot reports a numeric maxFeeGwei + verdict
log "[12g] gas --chain $CHAIN --json"
"$BIN" gas --chain "$CHAIN" --json 2>/dev/null | python3 -c "
import sys, json
s = json.loads(sys.stdin.read())[0] if isinstance(json.loads(sys.stdin.read() or '[]'), list) else None
" >/dev/null 2>&1 || true
# (the above is a noop because of the consumed stdin; do a fresh call)
"$BIN" gas --chain "$CHAIN" --json 2>/dev/null | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
s = data[0] if isinstance(data, list) else data
assert float(s['maxFeeGwei']) >= 0, 'no maxFeeGwei'
assert s['verdict'] in ('cheap','normal','expensive','unknown')
" && ok || ko "gas json shape unexpected"

# 12h) config validate exits 0 on valid config
log "[12h] config validate succeeds"
"$BIN" config validate >/dev/null 2>&1 && ok || ko "config validate failed unexpectedly"

# 12i) transfer simulate (read-only — never sends)
log "[12i] transfer ETH simulate to a third-party address"
WALLET_PASS="$WALLET_PASS" "$BIN" transfer ETH 0x0000000000000000000000000000000000000001 0.00001 --chain "$CHAIN" --simulate --json 2>/dev/null \
  | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d['simulated'] is True, 'not simulated'
assert d['ok'] is True, f'not ok: {d}'
assert d['to'].lower() == '0x0000000000000000000000000000000000000001', d['to']
" && ok || ko "transfer simulate shape unexpected"

# 12i1) Iter488: transfer --simulate runs without WALLET_PASS (parity with iter486 quote).
# Pre-iter488 every `transfer ... --simulate` prompted for the password even though no
# signing happens. Same env -u + closed-stdin pattern as smoke 10a so a re-introduced
# password prompt would EOF-fail loudly.
log "[12i1] iter488 transfer --simulate runs without WALLET_PASS"
out="$(env -u WALLET_PASS "$BIN" transfer ETH 0x0000000000000000000000000000000000000001 0.00001 --chain "$CHAIN" --simulate --json 2>/dev/null </dev/null)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d['simulated'] is True, f'not simulated: {d}'
assert d['ok'] is True, f'not ok: {d}'
" && ok || ko "iter488 transfer simulate without WALLET_PASS failed: $out"

# 12j) transfer self-rejection (capture output first; tradekit exits 1 + pipefail
# would otherwise mask grep's verdict).
log "[12j] transfer to self is rejected before send"
self_out="$(WALLET_PASS="$WALLET_PASS" "$BIN" transfer ETH 0x76e824220adfe18f4e7e8c907936588212cd67a8 0.00001 --chain "$CHAIN" --simulate 2>&1 || true)"
echo "$self_out" | grep -q "INVALID_PARAMS" && ok || ko "self-transfer was not rejected"

# 12j2) malformed address arguments are rejected with INVALID_PARAMS BEFORE the
# password prompt (iter77-79). Run WITHOUT WALLET_PASS — if the validation slips,
# the CLI would block on the password prompt and the test would hang.
log "[12j2] malformed address args fail fast (no password prompt)"
fails=""
out="$("$BIN" holdings 0xshort 2>&1 </dev/null || true)"
echo "$out" | grep -q "INVALID_PARAMS" || fails="$fails holdings"
out="$("$BIN" price 0xshort 2>&1 </dev/null || true)"
# price gets UNKNOWN_TOKEN (resolveToken rejects), not INVALID_PARAMS — either is fine.
echo "$out" | grep -qE "UNKNOWN_TOKEN|INVALID_PARAMS" || fails="$fails price"
out="$("$BIN" approve USDC 0xbadspender 2>&1 </dev/null || true)"
echo "$out" | grep -q "INVALID_PARAMS" || fails="$fails approve"
out="$("$BIN" trade buy --base NOPE_NOT_A_TOKEN --quoteAmount 1 2>&1 </dev/null || true)"
echo "$out" | grep -q "UNKNOWN_TOKEN" || fails="$fails trade"
[ -z "$fails" ] && ok || ko "fast-fail missed:$fails"

# 12k) token add/list/remove roundtrip — using a deliberately MIXED-CASE chain name
# to regression-test the iter95 case-normalization fix. Before iter95 this would
# have written chains.Base.tokens.SMOKETKN, invisible to token list (which looks
# under chains.base). The test now also asserts the mixed-case input round-trips.
log "[12k] token add/list/remove roundtrip (mixed-case chain name)"
CHAIN_MIXED="$(python3 -c "s='$CHAIN'; print(s[0].upper()+s[1:])")" # capitalize first letter, e.g. base→Base
"$BIN" token add "$CHAIN_MIXED" SMOKETKN 0xa0b86991c6218b36c1d19D4a2e9eb0ce3606eb48 >/dev/null 2>&1 || true
out="$("$BIN" token list "$CHAIN" 2>&1)"
if echo "$out" | grep -q SMOKETKN; then
  "$BIN" token remove "$CHAIN_MIXED" SMOKETKN >/dev/null 2>&1
  out2="$("$BIN" token list "$CHAIN" 2>&1)"
  if ! echo "$out2" | grep -q SMOKETKN; then ok; else ko "remove failed"; fi
else ko "add failed (mixed-case chain key not normalized)"; fi

# 12l) trade import — backfill an external swap; idempotent
log "[12l] trade import + idempotency"
SMOKE_TX="0x3e2a443fe7d922bf8ccb0b783c41f3ffbc0b07c7c10cbfc24bdb286b1808605d"
SMOKE_ACCT="smoke-test-account-$$"
DB_PATH="$HOME/.tradekit/tradekit.db"
# Pre-clean any leftover row from a prior run so we can observe inserted→duplicate.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" "DELETE FROM trades WHERE tx_hash='$SMOKE_TX' AND notes LIKE '%trade import%';" 2>/dev/null || true
fi
out1="$("$BIN" trade import "$SMOKE_TX" --chain "$CHAIN" --account "$SMOKE_ACCT" --json 2>/dev/null || true)"
out2="$("$BIN" trade import "$SMOKE_TX" --chain "$CHAIN" --account "$SMOKE_ACCT" --json 2>/dev/null || true)"
status1=$(echo "$out1" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('status', 'err'))")
status2=$(echo "$out2" | python3 -c "import sys, json; print(json.loads(sys.stdin.read()).get('status', 'err'))")
if [ "$status1" = "inserted" ] && [ "$status2" = "duplicate" ]; then ok
elif [ "$status1" = "skipped" ] && [ "$status2" = "skipped" ]; then
  echo "ok (tx aged out, skipped path)"; pass=$((pass+1))
else ko "import status1=$status1 status2=$status2"; fi
# Post-clean: remove the smoke-test row so reruns are reproducible.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" "DELETE FROM trades WHERE tx_hash='$SMOKE_TX' AND account='$SMOKE_ACCT';" 2>/dev/null || true
fi

# 12m) config get on unset path exits 1 (text mode preserves the exit-code contract
# that scripts like 12af rely on)
log "[12m] config get on unset path exits 1 (text mode)"
if "$BIN" config get safety.dailyUsdLimit >/dev/null 2>&1; then
  ko "unset path returned 0"
else
  ok
fi

# 12m2) Iter349: config get --json on unset path emits parseable {path, value: null, set: false}
# with exit 0, mirroring MCP's contract. Pre-iter349 this was empty stdout + exit 1, which
# broke any script doing `tradekit config get X --json | jq`.
log "[12m2] config get --json on unset path emits {value:null, set:false}"
out="$("$BIN" config get safety.dailyUsdLimit --json 2>/dev/null)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('set') is False, f'set != false: {env}'
assert env.get('value') is None, f'value != null: {env}'
assert env.get('path') == 'safety.dailyUsdLimit', f'path mismatch: {env}'
" && ok || ko "unset --json shape unexpected: $out"

# 12m5) Iter355: transfer to 0x0 refuses without --burn (catastrophic-by-default safety)
log "[12m5] transfer to 0x0 refused without --burn"
out="$(WALLET_PASS="$WALLET_PASS" "$BIN" transfer ETH 0x0000000000000000000000000000000000000000 0.0001 --chain "$CHAIN" --simulate 2>&1 || true)"
echo "$out" | grep -q "permanently BURN" && ok || ko "expected BURN warning, got: $out"

# 12m6) Iter355: transfer to 0x0 WITH --burn passes the burn-check (may fail elsewhere
# in --simulate mode for unrelated reasons like INSUFFICIENT_BALANCE on the smoke fork —
# the assertion is that the burn-refusal text is GONE, not that the simulate succeeds).
log "[12m6] transfer to 0x0 with --burn passes the burn-check"
out="$(WALLET_PASS="$WALLET_PASS" "$BIN" transfer ETH 0x0000000000000000000000000000000000000000 0.0001 --chain "$CHAIN" --simulate --burn 2>&1 || true)"
echo "$out" | grep -q "permanently BURN" && ko "burn-check still triggered with --burn" || ok

# 12ma) Iter377 + iter450: chains --json carries activeChain + chains + timestamp + ok envelope
log "[12ma] chains --json includes ok + activeChain + timestamp envelope"
out="$("$BIN" chains --json 2>/dev/null)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('ok') is True, f'iter450 ok field missing: {env}'
assert env.get('activeChain'), f'activeChain missing: {env}'
assert isinstance(env.get('chains'), list) and len(env['chains']) > 0, f'chains missing/empty: {env}'
assert env.get('timestamp', '').startswith('2'), f'timestamp missing/malformed: {env}'
" && ok || ko "chains --json envelope unexpected: $out"

# 12mb) Iter378 + iter456: audit prune --json emits action discriminator AND ok:true envelope
log "[12mb] audit prune --json emits noop-empty action + iter456 ok envelope"
out="$("$BIN" audit prune --before 9999d --json 2>&1 || true)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('ok') is True, f'iter456 ok field missing: {env}'
assert env.get('action') == 'noop-empty', f'expected noop-empty, got {env}'
assert env.get('count') == 0, f'count != 0: {env}'
assert env.get('before'), f'before missing: {env}'
" && ok || ko "audit prune --json shape unexpected: $out"

# 12md) Iter386: TRADEKIT_DATA_DIR with a bad path surfaces the env-var name in the error
log "[12md] TRADEKIT_DATA_DIR=/bad surfaces the env var in the error message"
out="$(TRADEKIT_DATA_DIR=/nonexistent/path/foo "$BIN" doctor --json 2>&1 || true)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('ok') is False, f'ok != false: {env}'
msg = env.get('error', {}).get('message', '')
assert 'Could not create data dir' in msg, f'expected friendly mkdir wrapper: {msg}'
assert 'TRADEKIT_DATA_DIR' in msg, f'env var name not in message: {msg}'
" && ok || ko "iter386 data-dir error shape unexpected: $out"

# 12me) Iter388: HOME=/dev/null (TRADEKIT_DATA_DIR unset) surfaces HOME in the error.
# /dev/null is a real path that ENOTDIR's on mkdir — reproducible across platforms.
log "[12me] HOME=/bad surfaces HOME in the error message (iter388)"
out="$(unset TRADEKIT_DATA_DIR; HOME=/dev/null "$BIN" doctor --json 2>&1 || true)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('ok') is False, f'ok != false: {env}'
msg = env.get('error', {}).get('message', '')
assert 'Could not create data dir' in msg, f'no mkdir wrapper: {msg}'
assert 'HOME' in msg, f'HOME not surfaced: {msg}'
assert 'fallback' in msg.lower() or 'falls back' in msg, f'no fallback explanation: {msg}'
" && ok || ko "iter388 HOME hint shape unexpected: $out"

# 12mc) Iter380: audit prune --json --yes pruned path (uses a fresh tmp data dir
# so the prune doesn't touch the smoke run's main audit history). Generates a few
# audit rows, then prunes everything older than now.
log "[12mc] audit prune --json --yes emits action=pruned with count>0"
PRUNE_TMP=$(mktemp -d)
TRADEKIT_DATA_DIR="$PRUNE_TMP" "$BIN" chain base >/dev/null 2>&1
TRADEKIT_DATA_DIR="$PRUNE_TMP" "$BIN" chain arbitrum >/dev/null 2>&1
TRADEKIT_DATA_DIR="$PRUNE_TMP" "$BIN" chain base >/dev/null 2>&1
sleep 1
FUTURE_DATE=$(python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
out="$(TRADEKIT_DATA_DIR="$PRUNE_TMP" "$BIN" audit prune --before "$FUTURE_DATE" --json --yes 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('action') == 'pruned', f'expected pruned, got {env}'
assert env.get('count') >= 1, f'count missing/zero: {env}'
assert env.get('oldestPruned'), f'oldestPruned missing'
assert env.get('newestPruned'), f'newestPruned missing'
" && ok || ko "audit prune --yes --json shape unexpected: $out"
rm -rf "$PRUNE_TMP"

# 12m9) Iter375: token list --json includes chain + timestamp envelope fields
log "[12m9] token list --json includes chain + timestamp"
out="$("$BIN" token list base --json 2>/dev/null)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('chain') == 'base', f'chain mismatch: {env.get(\"chain\")}'
assert 'tokens' in env, f'tokens missing'
assert 'builtin' in env, f'builtin missing'
assert 'custom' in env, f'custom missing'
assert 'timestamp' in env and env['timestamp'].startswith('2'), f'timestamp missing/malformed'
" && ok || ko "token list --json shape unexpected: $out"

# 12m4) Iter350: config validate --json on a valid config emits {ok:true, activeChain, chainOverrides}
log "[12m4] config validate --json on valid config emits {ok:true, ...}"
out="$("$BIN" config validate --json 2>/dev/null)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('ok') is True, f'ok != true: {env}'
assert env.get('activeChain'), f'activeChain missing: {env}'
assert 'chainOverrides' in env, f'chainOverrides missing: {env}'
" && ok || ko "validate --json shape unexpected: $out"

# 12m7) Iter363: config set --json emits action discriminator (set / updated / noop / removed)
log "[12m7] config set --json emits action discriminator"
$BIN config set safety.dailyUsdLimit 999 >/dev/null 2>&1 || true
out="$("$BIN" config set safety.dailyUsdLimit 999 --json 2>/dev/null)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('action') == 'noop', f'expected noop, got {env}'
" && ok || ko "config set --json noop shape unexpected: $out"
# Clean up — leave dailyUsdLimit unset so other smoke checks don't trip on it.
$BIN config set safety.dailyUsdLimit >/dev/null 2>&1 || true

# 12m8) Iter362: token add --json emits action discriminator (added / updated / shadowed)
log "[12m8] token add --json emits action discriminator"
out="$("$BIN" token add base SMOKETOKEN_363 0x4200000000000000000000000000000000000006 --json 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('action') in {'added', 'updated', 'shadowed'}, f'unexpected action: {env}'
assert env.get('chain') == 'base'
assert env.get('symbol') == 'SMOKETOKEN_363'
" && ok || ko "token add --json shape unexpected: $out"
# Clean up the test override so subsequent smoke runs don't accumulate cruft.
$BIN token remove base SMOKETOKEN_363 >/dev/null 2>&1 || true

# 12m3) Iter349: config get --json on SET path wraps the value
log "[12m3] config get --json on set path wraps in {path, value, set: true}"
out="$("$BIN" config get activeChain --json 2>/dev/null)"
echo "$out" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('set') is True, f'set != true: {env}'
assert env.get('value'), f'value missing: {env}'
assert env.get('path') == 'activeChain', f'path mismatch: {env}'
" && ok || ko "set --json shape unexpected: $out"

# 12n) trades --token filter is honored
log "[12n] trades --token UNLIKELY filter returns 0 rows"
out="$("$BIN" trades --token "ZZZZ_UNLIKELY_TOKEN" --include-legacy --format json 2>&1 || true)"
echo "$out" | python3 -c "
import sys, json
arr = json.loads(sys.stdin.read())
assert isinstance(arr, list) and len(arr) == 0, f'expected empty, got {len(arr)}'
" && ok || ko "token filter did not return empty"

# 12n2) Iter357: trades --since wires through iter356 shortcuts (today/Nh/Nd) and surfaces
# the filter in the empty-state scope summary (matches the iter236 audit pattern).
log "[12n2] trades --since today renders + surfaces filter in empty state"
out="$("$BIN" trades --since today --account zzz_unlikely_account 2>&1 || true)"
echo "$out" | grep -q "since=" && ok || ko "trades --since not surfaced in scope: $out"

# 12n3) Iter357: trades --since bogus value rejected with INVALID_PARAMS (iter337 envelope
# fires for --json mode; text mode prints the Error line).
log "[12n3] trades --since bogus rejected with INVALID_PARAMS"
out="$("$BIN" trades --since banana 2>&1 || true)"
echo "$out" | grep -q "Invalid --since: banana" && ok || ko "trades --since validation failed: $out"

# 12o) doctor's safety check renders without crashing under various configs
log "[12o] doctor safety line renders"
"$BIN" doctor 2>&1 | grep -qE "^  [✓!✗]  safety" && ok || ko "no safety line in doctor"

# 12p) watch mode runs at least one tick and exits cleanly on SIGINT
log "[12p] wallet view --watch 1 exits on SIGINT"
(
  WALLET_PASS="$WALLET_PASS" "$BIN" wallet view --chain "$CHAIN" --watch 1 >/tmp/watch.out 2>&1 &
  P=$!
  sleep 2
  kill -INT $P 2>/dev/null || true
  wait $P 2>/dev/null || true
)
if grep -q "tradekit watch" /tmp/watch.out; then ok; else ko "watch header not emitted"; fi
rm -f /tmp/watch.out

# 12q) pnl reports the new realized-after-gas accounting
log "[12q] pnl reports realized-after-gas"
out="$("$BIN" pnl --json 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert 'totalGasUsd' in d and 'totalRealizedAfterGasUsd' in d, 'missing gas fields'
" && ok || ko "pnl json missing gas accounting fields"

# 12r) allowances revoke-all --simulate path is read-only
log "[12r] allowances revoke-all --simulate is read-only"
out="$(WALLET_PASS="$WALLET_PASS" "$BIN" allowances revoke-all --chain "$CHAIN" --simulate 2>&1 || true)"
echo "$out" | grep -qE "(--simulate|No matching approvals)" && ok || ko "revoke-all simulate output unexpected"

# 12r1) Iter517: revoke-all --simulate runs WITHOUT WALLET_PASS (parity with iter486
# quote / iter488 transfer). Same env -u + closed-stdin pattern; a re-introduced
# password prompt would EOF-fail loudly instead of silently breaking.
log "[12r1] iter517 revoke-all --simulate runs without WALLET_PASS"
out="$(env -u WALLET_PASS "$BIN" allowances revoke-all --chain "$CHAIN" --simulate 2>&1 </dev/null || true)"
echo "$out" | grep -qE "(--simulate|No matching approvals)" && ok || ko "iter517 revoke-all simulate without WALLET_PASS failed: $out"

# 12s) doctor sqlite line includes a size
log "[12s] doctor sqlite line shows size"
"$BIN" doctor 2>&1 | grep -qE "sqlite.*MB" && ok || ko "no sqlite size in doctor"

# 12t) init wizard non-interactive in isolated HOME
log "[12t] init --non-interactive sets chain + safety in fresh HOME"
TMP_HOME="$(mktemp -d)"
HOME="$TMP_HOME" WALLET_PASS=smoketestpw "$BIN" init \
  --non-interactive --wallet-type hd --chain arbitrum \
  --per-tx-limit 123 --max-slippage-bps 250 \
  >/tmp/init.out 2>&1 || true
HOME="$TMP_HOME" "$BIN" config show 2>/dev/null \
  | python3 -c "
import sys, json
c = json.loads(sys.stdin.read())
assert c['activeChain'] == 'arbitrum', f'chain={c[\"activeChain\"]}'
assert c['safety']['perTxUsdLimit'] == 123, c['safety']['perTxUsdLimit']
assert c['safety']['maxSlippageBps'] == 250, c['safety']['maxSlippageBps']
" && ok || ko "init non-interactive did not write expected config"
rm -rf "$TMP_HOME" /tmp/init.out

# 12u) audit --account filter
log "[12u] audit --account filter returns only that account's rows"
out="$("$BIN" audit --account NO_SUCH_ACCOUNT_XYZ --limit 10 2>&1 || true)"
# Should return zero rows (or maybe a header? our format prints rows only)
if [ -z "$(echo "$out" | grep -v '^$')" ]; then ok; else ko "filter returned rows for nonexistent account"; fi

# 12v) logs --tail returns recent lines
log "[12v] logs --tail 3 returns up to 3 lines"
"$BIN" logs --tail 3 2>/dev/null | wc -l | awk '{ if ($1 <= 4) print "ok"; else print "FAIL"; exit }' \
  | grep -q ok && ok || ko "logs --tail returned too many lines"

# 12w) transfer max resolves to balance minus gas reserve
# Iter407: also asserts the gasReserveNative field is present + positive when native max.
log "[12w] transfer ETH max --simulate resolves to balance-ε + carries gasReserveNative"
out="$(WALLET_PASS="$WALLET_PASS" "$BIN" transfer ETH 0x0000000000000000000000000000000000000001 max --chain "$CHAIN" --simulate --json 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d['simulated'] is True, 'not simulated'
amt = float(d['amount'])
assert amt > 0, f'amount={amt}'
# Iter407: native max-mode must surface the reserve held back.
reserve = d.get('gasReserveNative')
assert reserve is not None, f'gasReserveNative missing (iter407): {d}'
assert float(reserve) > 0, f'gasReserveNative not positive: {reserve}'
" && ok || ko "transfer max didn't resolve to a positive amount"

# 12x) trade sell --baseAmount max --simulate resolves balance
# Iter408: also asserts gasReserveNative is present + positive for native sell-max.
log "[12x] trade sell --baseAmount max resolves to balance + carries gasReserveNative"
out="$(WALLET_PASS="$WALLET_PASS" "$BIN" trade sell --base ETH --quote USDC --baseAmount max --chain "$CHAIN" --simulate --json 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d['simulated'] is True, 'not simulated'
amt = float(d['baseAmount'])
assert amt > 0, f'baseAmount={amt}'
# Iter408: native sell-max must surface the reserve held back.
reserve = d.get('gasReserveNative')
assert reserve is not None, f'gasReserveNative missing (iter408): {d}'
assert float(reserve) > 0, f'gasReserveNative not positive: {reserve}'
" && ok || ko "sell max didn't resolve to a positive amount"

# 12y) first-run hint in fresh HOME
log "[12y] first-run hint shows on bare invocation without wallet"
TMP_HOME="$(mktemp -d)"
out="$(HOME="$TMP_HOME" "$BIN" 2>&1 || true)"
echo "$out" | grep -q "tradekit init" && ok || ko "no init hint shown"
rm -rf "$TMP_HOME"

# 12z) trade size context shows balanceFraction for max-amount sell
log "[12z] trade size context surfaces balanceFraction"
out="$(WALLET_PASS="$WALLET_PASS" "$BIN" trade sell --base ETH --quote USDC --baseAmount max --chain "$CHAIN" --simulate --json 2>/dev/null || true)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
bf = d.get('balanceFraction')
assert bf is not None and bf > 0, f'no balanceFraction: {bf}'
" && ok || ko "no balanceFraction in result"

# 12aa) doctor RPC check includes per-endpoint detail rows (when not all OK)
log "[12aa] doctor RPC details are listed for warn/fail chains"
out="$("$BIN" doctor 2>&1)"
# Look for a detail line under rpc:base (indented + a known Base RPC host appears with latency)
echo "$out" | grep -qE "  [✓✗] (mainnet.base.org|base-rpc.publicnode.com|1rpc.io)" && ok || ko "no per-RPC detail rows"

# 12ab) Web UI end-to-end: bundle + API endpoints + auth + SPA fallback + shutdown.
# Starts the server once, exercises every critical /api/* path, then stops cleanly.
# Saves the bundle to disk so the grep doesn't fight shell variable mangling.
log "[12ab] web UI: bundle + APIs + auth + SPA fallback"
WALLET_PASS="$WALLET_PASS" "$BIN" web --port 3099 >/tmp/web_smoke.out 2>&1 &
WP=$!
sleep 2
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /tmp/web_smoke.out | head -1 | sed 's/token=//')

web_ok=1
fail_reasons=""

check_json() {
  local label="$1" url="$2" pyexpr="$3"
  if ! curl -sf -H "Authorization: Bearer $TOKEN" "$url" 2>/dev/null \
    | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); assert $pyexpr, 'shape: '+repr(d)[:120]" 2>/dev/null; then
    web_ok=0; fail_reasons="$fail_reasons $label"
  fi
}

check_json status     "http://127.0.0.1:3099/api/status"     "d['ok'] and 'chains' in d and d.get('version',{}).get('tradekit')"
check_json config     "http://127.0.0.1:3099/api/config"     "d['ok'] and d['config']['activeChain']"
check_json chains     "http://127.0.0.1:3099/api/chains"     "d['ok'] and len(d['chains'])==6"
check_json holdings   "http://127.0.0.1:3099/api/holdings?chains=$CHAIN" "d['ok'] and isinstance(d['reports'],list)"
check_json trades     "http://127.0.0.1:3099/api/trades?limit=1" "d['ok']"
check_json pnl        "http://127.0.0.1:3099/api/pnl"        "d['ok'] and 'totalGasUsd' in d['report']"
check_json audit      "http://127.0.0.1:3099/api/audit?limit=1" "d['ok']"
check_json allowances "http://127.0.0.1:3099/api/allowances" "d['ok']"
# Iter427: pin the iter422/423 trending envelope shape on the web surface. Same
# {ok, query, chain, pairs, timestamp} keys that iter424 pinned on the CLI.
# query is null when no ?q= provided (trending-on-chain branch).
check_json trending   "http://127.0.0.1:3099/api/trending?chain=$CHAIN&limit=3" "d['ok'] and d['query'] is None and d['chain'] and isinstance(d['pairs'],list) and d.get('timestamp')"

# Bundle inspection — write to file so binary-ish content doesn't get mangled.
curl -sf -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3099/ > /tmp/web_smoke.html 2>/dev/null
asset_path="$(grep -oE '/assets/[^"]+\.js' /tmp/web_smoke.html | head -1)"
if [ -n "$asset_path" ]; then
  curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3099$asset_path" > /tmp/web_smoke.js 2>/dev/null
  for marker in Overview Holdings Trade Chart Approvals "Revoke ALL" "Active account" "Active chain" "Use full balance" hashchange replaceState "Swap base"; do
    if ! grep -qF -- "$marker" /tmp/web_smoke.js; then
      web_ok=0; fail_reasons="$fail_reasons bundle:$marker"
    fi
  done
else
  web_ok=0; fail_reasons="$fail_reasons no-asset"
fi

# Auth: 401 on no token, 200 on valid.
code_unauthed=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3099/api/status)
[ "$code_unauthed" = "401" ] || { web_ok=0; fail_reasons="$fail_reasons unauthed=$code_unauthed"; }

# SPA fallback: unknown route → 200 (serves index.html).
code_spa=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3099/some/spa/route)
[ "$code_spa" = "200" ] || { web_ok=0; fail_reasons="$fail_reasons spa=$code_spa"; }

# Iter373: defense-in-depth security headers. Pin each one so a future middleware
# refactor can't silently drop them. Header values use case-insensitive grep since
# Express may title-case the header name.
hdrs=$(curl -sI -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3099/api/status" 2>/dev/null)
echo "$hdrs" | grep -qi "^X-Frame-Options:\\s*DENY" || { web_ok=0; fail_reasons="$fail_reasons no-x-frame-options"; }
echo "$hdrs" | grep -qi "^X-Content-Type-Options:\\s*nosniff" || { web_ok=0; fail_reasons="$fail_reasons no-x-content-type-options"; }
echo "$hdrs" | grep -qi "^Referrer-Policy:\\s*same-origin" || { web_ok=0; fail_reasons="$fail_reasons no-referrer-policy"; }
echo "$hdrs" | grep -qi "^X-Powered-By:" && { web_ok=0; fail_reasons="$fail_reasons x-powered-by-leaked"; }

# Graceful shutdown.
kill -INT $WP 2>/dev/null || true
wait $WP 2>/dev/null || true
sleep 1
if kill -0 $WP 2>/dev/null; then
  kill -9 $WP 2>/dev/null || true
  web_ok=0; fail_reasons="$fail_reasons no-shutdown"
fi
rm -f /tmp/web_smoke.out /tmp/web_smoke.html /tmp/web_smoke.js

if [ "$web_ok" = "1" ]; then ok; else ko "web checks failed:$fail_reasons"; fi

# 12ac) categorized help has section headers + iter442 env-var docs
# Pre-iter442 only WALLET_PASS appeared in help. Iter442 added ENVIRONMENT with the
# full set of TRADEKIT_* env vars an operator might want to tune. Pin the section
# header AND a representative env-var so a refactor that drops the block fails smoke.
log "[12ac] help has SETUP / WALLET / TRADING / ENVIRONMENT sections + env-var entries"
out="$("$BIN" help 2>&1)"
echo "$out" | grep -q "^SETUP" && \
echo "$out" | grep -q "^WALLET" && \
echo "$out" | grep -q "^TRADING" && \
echo "$out" | grep -q "^ENVIRONMENT" && \
echo "$out" | grep -q "TRADEKIT_DATA_DIR" && \
echo "$out" | grep -q "TRADEKIT_WEB_TOKEN" && \
echo "$out" | grep -q "TRADEKIT_RECEIPT_TIMEOUT_MS" && ok || ko "help sections / iter442 env-var docs missing"

# 12ad) config push/drop roundtrip on a fresh array field
log "[12ad] config push/drop on a fresh array field"
TEST_PATH="safety.tokenWhitelist.smoke-iter16"
TEST_VAL="0xa0b86991c6218b36c1d19D4a2e9eb0ce3606eb48"
"$BIN" config push "$TEST_PATH" "$TEST_VAL" >/dev/null 2>&1 || true
out1="$("$BIN" config get "$TEST_PATH" 2>/dev/null || true)"
"$BIN" config drop "$TEST_PATH" "$TEST_VAL" >/dev/null 2>&1 || true
out2="$("$BIN" config get "$TEST_PATH" 2>/dev/null || true)"
# Cleanup the leftover empty array key.
"$BIN" config set "$TEST_PATH" >/dev/null 2>&1 || true
echo "$out1" | grep -q "$TEST_VAL" && [ -z "$(echo "$out2" | grep "$TEST_VAL")" ] \
  && ok || ko "push/drop roundtrip failed (push=$out1 drop=$out2)"

# 12af) reconcile reports a valid shape even when there are no pending rows
# Iter446: also pins the ok:true envelope field added for parity with iter422/431/445.
log "[12af] reconcile --json returns valid report shape + iter446 ok envelope"
out="$("$BIN" reconcile --json 2>&1 || true)"
echo "$out" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
assert d.get('ok') is True, f'iter446 ok field missing: {d}'
for k in ('scanned','resolvedSuccess','resolvedFailed','stillPending','errors'):
    assert k in d, f'missing {k}: {d}'
assert isinstance(d['errors'], list)
" && ok || ko "reconcile json shape unexpected: $out"

# 12ag) trades --pending honored (and consistent with --status pending)
log "[12ag] trades --pending filter produces an array"
out="$("$BIN" trades --pending --format json 2>&1 || true)"
echo "$out" | python3 -c "
import sys, json
arr = json.loads(sys.stdin.read())
assert isinstance(arr, list)
# Every returned row must be pending (or list is empty — fine either way).
for r in arr:
    assert r.get('status') == 'pending', f'non-pending row leaked: {r}'
" && ok || ko "--pending filter shape unexpected"

# 12aj) iter335/337: --json mode emits a stable error envelope on stderr matching
# the web shape. Trigger a deterministic INVALID_PARAMS (no network needed): bad
# --status value. Stdout should be empty; stderr should be parseable JSON with
# { ok: false, error: { code, message }, ... }.
log "[12aj] --json error envelope shape on stderr (iter335/337)"
out_stdout="$("$BIN" trades --status banana --json 2>/tmp/trades_err.json || true)"
out_stderr="$(cat /tmp/trades_err.json 2>/dev/null || echo "")"
if [ -n "$out_stdout" ]; then
  ko "stdout was not empty on error: $out_stdout"
elif echo "$out_stderr" | python3 -c "
import sys, json
env = json.loads(sys.stdin.read())
assert env.get('ok') is False, f'ok != false: {env}'
assert env.get('error', {}).get('code') == 'INVALID_PARAMS', f'code != INVALID_PARAMS: {env}'
assert 'banana' in env.get('error', {}).get('message', ''), f'message missing banana: {env}'
" 2>/dev/null; then ok; else ko "error envelope shape unexpected: $out_stderr"; fi
rm -f /tmp/trades_err.json

# 12ah) doctor --pass verifies the keystore decrypts (status: password verified)
log "[12ah] doctor --pass surfaces 'password verified' for the wallet line"
out="$("$BIN" doctor --pass "$WALLET_PASS" --chains "$CHAIN" 2>&1 || true)"
echo "$out" | grep -qE "wallet .*password verified" && ok || ko "no 'password verified' in doctor output"

# 12ah1) Iter471: doctor's wrong-password path surfaces iter435's env-var hint (within
# iter437's 240-char hint cap). Pre-iter437 the cap was 120; iter435's "WALLET_PASS is
# set in your environment" advice would have been truncated. Pinning both: the iter435
# message reaches the operator AND the iter437 cap is high enough. WALLET_PASS env
# is set in the smoke run, so iter435's env-set branch fires.
log "[12ah1] doctor --pass with bad password surfaces iter435/iter437 hint"
out="$("$BIN" doctor --pass "definitely-not-the-right-password-iter471" --chains "$CHAIN" 2>&1 || true)"
echo "$out" | grep -qE "decrypt failed.*WRONG_PASSWORD" && \
echo "$out" | grep -q "WALLET_PASS is set in your environment" && ok || ko "iter435/iter437 hint missing from doctor wrong-password output: $(echo "$out" | tail -5)"

# 12ae) MCP fails fast on a wrong wallet password
# Bare `wait` returning the MCP process's non-zero exit would trip `set -e`, so we
# guard every potentially-failing call with `|| true`.
# Iter438: also assert the iter435 actionable hint reaches stderr. WALLET_PASS is set
# in env here (we're using it to pass the bad password), so the env-set branch fires —
# the operator should see "WALLET_PASS is set in your environment" + the unset/--pass
# recovery hint. A refactor that drops env-detection would silently regress the UX.
log "[12ae] MCP exits non-zero on wrong password + surfaces iter435 env-var hint"
WALLET_PASS="definitely-not-the-right-password-iter16" "$BIN" mcp </dev/null >/dev/null 2>/tmp/mcp_iter16.err &
P=$!
sleep 3
if kill -0 $P 2>/dev/null; then
  kill $P 2>/dev/null || true
  wait $P 2>/dev/null || true
  ko "MCP did not exit on wrong password"
else
  wait $P 2>/dev/null || true
  if grep -q "MCP startup failed.*WRONG_PASSWORD" /tmp/mcp_iter16.err \
     && grep -q "WALLET_PASS is set in your environment" /tmp/mcp_iter16.err; then
    ok
  else
    ko "no WRONG_PASSWORD or iter435 env-var hint in stderr"
    cat /tmp/mcp_iter16.err | head -5
  fi
fi
rm -f /tmp/mcp_iter16.err

# 12ai) Web fails fast on a wrong wallet password (parity with MCP fail-fast)
log "[12ai] Web exits non-zero on wrong password (before binding the listener)"
WALLET_PASS="definitely-not-the-right-password-iter52" "$BIN" web --port 3098 </dev/null >/dev/null 2>/tmp/web_passfail.err &
WP_FAIL=$!
sleep 3
if kill -0 $WP_FAIL 2>/dev/null; then
  kill $WP_FAIL 2>/dev/null || true
  wait $WP_FAIL 2>/dev/null || true
  ko "Web did not exit on wrong password"
else
  wait $WP_FAIL 2>/dev/null || true
  if grep -q "Web startup failed.*WRONG_PASSWORD" /tmp/web_passfail.err; then ok; else ko "no WRONG_PASSWORD in web stderr"; fi
fi
rm -f /tmp/web_passfail.err

# 12) MCP server starts and lists tools
log "[12] MCP server lists ≥18 tools"
MCP_OUT="$(mktemp)"
{
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 5  # keep stdin open long enough for the server to respond before EOF closes us
} | "$BIN" mcp >"$MCP_OUT" 2>/dev/null || true
tools_count=$(grep -E '"tools":\[' "$MCP_OUT" | head -1 | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(len(d.get('result', {}).get('tools', [])))
except Exception:
    print(0)
" || echo 0)
rm -f "$MCP_OUT"
if [ "${tools_count:-0}" -ge 18 ]; then ok; else ko "got tools_count=${tools_count:-0}"; fi

echo ""
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
