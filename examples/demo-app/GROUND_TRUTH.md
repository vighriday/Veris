# Demo App — Ground Truth

Synthetic TS/JS app with **planted issues** across 9 workflow domains. Veris runs against it; this file is the answer key.

Two kinds of expectation per file:

- **Graph expectation** — node should be detected, classified into the listed workflow, with the listed dependencies/invokes.
- **Risk expectation** — Veris should surface the listed runtime risks and adversarial probes for the file's workflow.

Bugs are *real* — they would fail the listed adversarial probe if it were executed. Veris does not execute the probe; it emits the directive. The "Probe that would catch it" column is what Veris should print under that file's workflow.

---

## File → expected workflow → planted issue

### Authentication

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/auth/login.ts` | Authentication | `verifyToken` uses `<` instead of `<=` on expiry — exactly-at-boundary token passes once after expiry second ticks over | Refresh token at the exact expiry boundary while two requests in flight |
| `src/auth/login.ts` | Authentication | `refreshToken` issues new JWT without revoking old → both valid until exp | Replay a captured login response after logout |
| `src/auth/oauth.js` | Authentication | OAuth callback has no `code` replay guard — second callback with same code creates a duplicate session | OAuth callback arrives twice for the same code parameter |
| `src/auth/session.ts` | Session | `issueSession` overwrites without atomic SETNX → concurrent logins race | Two parallel requests refresh the session cookie simultaneously |

### Payments / Checkout

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/payments/charge.ts` | Payments | No idempotency key on `stripe.charges.create` — retry creates two charges | Submit charge twice with the same idempotency key inside a 500ms window |
| `src/payments/charge.ts` | Payments | DB insert is *after* gateway call — if insert fails we have a charge with no record | Capture succeeds at gateway, response times out before reaching us |
| `src/payments/checkout.ts` | Checkout | `placeOrder` is not in a transaction — order row exists even if charge fails | Two clients submit the same cart concurrently after inventory dropped to 1 |
| `src/payments/checkout.ts` | Checkout | Inventory not decremented or locked → oversell race | Two clients submit the same cart concurrently |

### Webhooks

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/webhooks/stripeWebhook.js` | Webhooks | Signature check has no timestamp window → 24h-old replay accepted | Replay a 24-hour-old signed payload with the original signature |
| `src/webhooks/stripeWebhook.js` | Webhooks | Handler is not idempotent — 50 retries of same event update DB 50 times, send 50 emails | Sender delivers 50 retries of the same event id within 1 minute |

### Caching

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/cache/productCache.ts` | Caching | `getProduct` cache-miss path has no single-flight — mass expiry stampedes origin | Mass cache expiry triggers thundering herd on origin |
| `src/cache/productCache.ts` | Caching | `updateProduct` does not call `invalidate` → stale-after-write forever (until TTL) | Invalidation event arrives out of order with the write |

### Queue

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/queue/fulfillment.ts` | Queue | Worker performs side effects (UPDATE, INSERT shipment, sendEmail) without idempotency key — re-delivery duplicates | Worker crashes after side effect but before ack |
| `src/queue/fulfillment.ts` | Queue | No visibility-timeout / lock — two workers can grab same job | Two consumers visibility-timeout race on the same job |

### Persistence

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/db/orderRepo.ts` | Persistence | `getOrdersWithItems` does N+1: one query per order | N+1 on hot path |
| `src/db/orderRepo.ts` | Persistence | `migrate` runs DDL at request time, not as a managed migration | Migration ordering hazard |

### Routing

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/routes/api.ts` | Routing | `/admin/users` has **no `requireAuth`** — unauthenticated request reaches handler | Middleware order changes — unauthenticated request reaches handler |
| `src/routes/api.ts` | Routing | `/webhooks/stripe` has no `express.raw()` body parser → signature verification breaks silently | Auth bypass via route change |

### AI

| File | Expected workflow | Planted issue | Probe that should fire |
|------|-------------------|---------------|----------------------|
| `src/ai/agent.ts` | AI | `callTool` does not validate JSON shape before returning to caller — tool can return anything | Tool returns schema-violating JSON to the model |
| `src/ai/agent.ts` | AI | No context-window budget — history grows unbounded | Context-window overflow |

---

## Coverage targets

Veris must:

1. **Detect every file as a node** — `src/` has 12 source files (excluding `index.js` entry). All 12 must appear in graph.
2. **Classify each into the expected workflow** above (with maybe 1–2 nodes also in `Core` / `Uncategorized` if rules are tight — acceptable).
3. **List at least one runtime risk per workflow** matching `data/runtime-risks.json`.
4. **Generate the listed adversarial probe** under that workflow.
5. **Score Payments / Webhooks / Auth as higher criticality** than Search / Profile.

## What the dashboard should show

- ≥ 8 workflows detected: Authentication, Session, Payments, Checkout, Webhooks, Caching, Queue, Persistence, Routing, AI.
- ≥ 1 high-risk node per critical workflow (Payments, Webhooks, Auth).
- Graph edges resolve cross-module: `checkout.ts → charge.ts`, `charge.ts → notifier.ts`, `api.ts → checkout.ts`, `oauth.js → userRepo.js`, etc.
- CommonJS files (`oauth.js`, `stripeWebhook.js`, `userRepo.js`, `index.js`) all detected with their exports.
- `index.js` prototype methods on `PaymentReconciler` (reconcile, replay) should appear grouped under that class.

## Acceptable misses (best-practice gap, not bug)

- Veris does not *read the code body* to find `<` vs `<=` — it surfaces the workflow + probe and the human/agent verifies. That is by design.
- Veris does not *prove* idempotency — it flags Payments / Webhooks / Queue as needing the idempotency probe. Same disclaimer.

## Hard fail conditions

Veris is broken if any of these happen on this app:

- Fewer than 10 nodes detected.
- `stripeWebhook.js` not classified as Webhooks.
- `charge.ts` not classified as Payments.
- `api.ts` not classified as Routing.
- Adversarial probes printed for workflow X don't match `data/probes.json[X]`.
- Same probe text printed for unrelated workflows (cross-contamination).
- Confidence > 0.9 with zero execution feedback (would mean math is broken).
