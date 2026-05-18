# Demo-app snapshot — Veris 2.1.4

Run against [`examples/demo-app/`](../demo-app) — a synthetic TS/JS app with bugs planted across 11 workflows. The answer key lives at [`examples/demo-app/GROUND_TRUTH.md`](../demo-app/GROUND_TRUTH.md).

## Run command

```
cd examples/demo-app
npx veris-core .
open veris-reports/veris-dashboard.html
```

## Headline numbers

| Metric | Value |
|---|---|
| Source files analyzed | 13 (TS + JS, CommonJS + ESM) |
| Graph nodes | 37 |
| Graph edges | 16 |
| Workflows detected | 11 |
| Probes generated | 18 |
| Workflow kinds covered by probes | AI, Authentication, Caching, Checkout, Notifications, Payments, Persistence, Queue, Routing, Session, Webhooks |

## Ground-truth coverage

Every planted bug has a matching adversarial probe under its expected workflow. Veris does **not** read the bug body — it surfaces the workflow and the scenario the agent (or human) must run to catch it.

| Planted bug | File | Workflow detected | Probe fired |
|---|---|---|---|
| JWT expiry uses `<` not `<=` | `auth/login.ts` | Authentication | "Refresh token at the exact expiry boundary while two requests are in flight" |
| Old token still valid after refresh | `auth/login.ts` | Authentication | "Replay a captured login response after logout" |
| OAuth callback has no replay guard | `auth/oauth.js` | Authentication | "OAuth callback arrives twice for the same code parameter" |
| Session overwrite race | `auth/session.ts` | Session | "Two parallel requests refresh the session cookie simultaneously" |
| Stripe charge has no idempotency key | `payments/charge.ts` | Payments | "Submit charge twice with the same idempotency key inside a 500ms window" |
| DB insert after gateway call | `payments/charge.ts` | Payments | "Capture succeeds at gateway, response times out before reaching us" |
| Order placement not in transaction | `payments/checkout.ts` | Checkout | "Two clients submit the same cart concurrently after inventory dropped to 1" |
| Webhook signature has no timestamp window | `webhooks/stripeWebhook.js` | Webhooks | "Replay a 24-hour-old signed payload with the original signature" |
| Webhook handler not idempotent | `webhooks/stripeWebhook.js` | Webhooks | "Sender delivers 50 retries of the same event id within 1 minute" |
| Cache miss has no single-flight | `cache/productCache.ts` | Caching | "Mass cache expiry triggers thundering herd on origin" |
| `updateProduct` does not invalidate cache | `cache/productCache.ts` | Caching | "Invalidation event arrives out of order with the write" |
| Worker side-effects not idempotent | `queue/fulfillment.ts` | Queue | "Worker crashes after side effect but before ack" |
| No visibility-timeout lock | `queue/fulfillment.ts` | Queue | "Two consumers visibility-timeout race on the same job" |
| N+1 in `getOrdersWithItems` | `db/orderRepo.ts` | Persistence | "Two transactions update the same row; commit order non-deterministic" |
| `/admin/users` has no auth middleware | `routes/api.ts` | Routing | "Middleware order changes — unauthenticated request reaches handler" |
| `callTool` does not validate JSON | `ai/agent.ts` | AI | "Tool returns schema-violating JSON to the model" |
| Duplicate notification dispatch | `utils/notifier.ts` | Notifications | "Duplicate enqueue of the same notification id" |

## What this run actually exercised

- **CommonJS extraction** — `auth/oauth.js` uses `require()` + `module.exports = {}`. `db/userRepo.js` uses `module.exports.X = function() {}` (four exports). `webhooks/stripeWebhook.js` mixes both. `src/index.js` uses `function Foo() {}` + `Foo.prototype.method = function() {}`. All detected.
- **Workflow classifier path-weight tiering** — `cache/productCache.ts` imports nothing from `db/` but uses `redis` (which Caching's import-token catches). Path `cache/` beats every other signal. `auth/session.ts` has `cache` in its import path (`../cache/redisClient`) but classifier correctly anchors it to Session via the `session` path segment.
- **Adversarial probe per-workflow coverage** — every workflow with an impacted member gets its probe deck. Previous build emitted probes only for nodes above a hard risk threshold, which silently dropped Caching, AI, Notifications, etc.

## Bugs found in Veris itself during this exercise

The first run on this demo app surfaced four real defects in Veris:

1. **GitDiffDriver subpath leakage** — when `projectRoot` is a subdir of a larger git repo, the worktree-based base analysis crawled the entire parent tree, contaminating risk + probe output with unrelated nodes. Fixed in `src/engine/GitDiffDriver.ts` to scope the base analysis to the same relative subpath the user pointed at.
2. **BehavioralDiffEngine added stale nodes** — `impactedNodes` fell back to `oldNodesMap.get(...)` when a removed edge's source was missing from head, leaking deleted-module nodes into risk scoring. Fixed in `src/engine/BehavioralDiffEngine.ts`.
3. **Isolated added nodes never marked impacted** — an entirely new file with no graph edges (e.g., `cache/productCache.ts` only touches external `redis` + `db`) was silently dropped from risk scoring. Fixed: every added node now enters `impactedNodes`.
4. **Probe generator emitted per-node not per-workflow** — three Auth nodes meant three duplicate copies of each Auth probe. Other workflows with no high-risk anchor (Caching, AI) got zero probes. Refactored to emit a deduped probe deck per workflow, anchored to the workflow's highest-risk member.
5. **Classifier camelCase blind spot** — `matchesSymbol` used a strict word-boundary regex, so `issueSession` did not match symbolToken `session`. Now splits camelCase into components before matching.
6. **Path token vs import token weight** — a file that imports `ioredis` but lives in `payments/` was getting equal Caching and Payments signal. Path-token match strength (exact / prefix / scoped) now tiered: exact segment match outranks any import-token match.

All six fixes shipped together. The before/after on this same demo app:

| | Before | After |
|---|---|---|
| Risks (correct scope) | 117 (84 from parent repo) | 37 |
| Probes generated | 15 | 18 |
| Workflow kinds covered | 3 (Auth, Payments, Checkout) | 11 (every kind) |
| `session.ts` workflow | Caching (wrong) | Session ✓ |
| Caching/AI probes | 0 | 4 |

## Acceptable misses

- Veris does **not** parse function bodies to find `<` vs `<=`. It surfaces the workflow and the probe scenario; the human or agent runs the probe. That is by design.
- `routes/api.ts` route handlers are anonymous arrow functions passed to `router.post(...)`. ts-morph only names exported / declared symbols, so `requireAuth` shows up but the handler closures do not. The Routing workflow still fires the correct probe.

## Reproducing

The full payload (graph, risks, workflows, probes, drift, plan, budget) is embedded in `examples/demo-app/veris-reports/veris-dashboard.html` under `const PAYLOAD`. Extract it with:

```bash
node -e "const fs=require('fs');const h=fs.readFileSync('examples/demo-app/veris-reports/veris-dashboard.html','utf8');const m=h.match(/const PAYLOAD = (\{[\s\S]*?\});/);fs.writeFileSync('payload.json',JSON.stringify(eval('('+m[1]+')'),null,2));"
```

`payload.json` matches the JSON contract published at `veris schema`.
