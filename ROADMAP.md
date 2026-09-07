# Veris Roadmap

Living document. Reflects intent, not commitments. PRs welcome on any item.

## Where the project actually is

A full architecture audit produced 52 confirmed findings, all now addressed and
tracked with evidence in [`docs/internal/BUG_TRACKER.md`](docs/internal/BUG_TRACKER.md).
Several were severe: a fabricated baseline shipped through five call sites, call
edges inferred by name matching (91% ambiguous on a real dependency), and an
evidence store the evaluated agent could overwrite.

Those are fixed. The honest summary of what exists now:

- **The substrate is trustworthy.** Baselines are real merge-base comparisons or the
  run fails. Call edges come from the TypeScript checker and declare how they were
  resolved. Node identity is portable and includes a body hash. Evidence is
  append-only, hash-chained and attributed.
- **The semantic layer is still shallow.** Workflow classification is a keyword vote
  that never reads the graph. This is the largest open design question in the project.
- **Nothing is calibrated.** Risk ranks; coverage measures evidence. Neither predicts
  failure, and the docs now say so.

## Now (v2.2 — build on the fixed substrate)

- [x] Checker-backed call resolution with typed edge provenance.
- [x] Merge-base baselines, tracked-file scoping, no fabricated fallback.
- [x] Repository-relative node identity + normalized body hashes.
- [x] Append-only, hash-chained, trust-typed execution evidence.
- [x] Validated, size-capped MCP surface with mtime cache invalidation.
- [x] Opt-in plugin execution with disclosure.
- [x] 235 tests over 19 files; first coverage of ingest, git, state, plugins, MCP,
      reporting and registry.
- [ ] Ground-truth harness: wire `examples/demo-app/GROUND_TRUTH.md` into a golden
      test so classification accuracy is measured rather than asserted in prose.
- [ ] Precision/recall on workflow classification against hand-labelled repositories.
- [ ] SARIF and CSV export for CI pipelines.
- [ ] PR comment integration via a GitHub App.

## Next (v2.3 — make the semantic layer real)

The single highest-leverage change available. Today a workflow is a bag of
declarations sharing a keyword-voted label. It should be a path.

- [ ] **Entry-point discovery**: HTTP routes, CLI commands, exported handlers, queue
      consumers, scheduled jobs. A workflow starts somewhere.
- [ ] **Traversal from entry points** over the now-trustworthy call graph, so a
      workflow has ordering, boundaries and an exit — not just membership.
- [ ] **Co-change signal** from git history: files repeatedly edited together are
      related, and it is free, language-independent evidence that needs no rules.
- [ ] Keywords demoted to *naming* a discovered cluster rather than *finding* it.
- [ ] Framework adapters: Express, Fastify, NestJS, Next.js routes, Django, FastAPI.

## Soon (v2.4 — language reach)

- [ ] Python adapter (tree-sitter or `ast`), with resolution provenance equivalent to
      the TS checker path — an adapter that guesses would reintroduce the defect the
      audit removed.
- [ ] Go adapter.
- [ ] Multi-language monorepos: a workflow spanning a TS frontend and a Python backend.
- [ ] Plugin manifest spec (`veris-plugin.json`) with capability declarations, so a
      plugin can state what it needs rather than receiving the whole process.

## Later (v3.0 — evidence as the product)

The audit clarified what is defensible here. Veris' scarce asset is that it sits
inside the agent loop while every comparable tool runs after the fact, and it now has
an evidence store worth trusting. The direction that follows from that:

- [ ] **Oracle integrity**: parse test files for what they actually assert, ingest
      coverage attributed to changed lines rather than files, and report whether each
      changed behaviour has a real check behind it. Published research puts ~65% of
      agent-authored PRs at zero coverage of their own changed lines.
- [ ] **Signed decisions**: `Decision { allow | warn | deny, ruleIds[], evidence[],
      policyVersion }` over a typed fact base — deterministic, attributable, and
      arguable in a way a score never is. Enforcement stays with CI or the agent
      harness; Veris never executes.
- [ ] **Versioned policy bundles** through the existing `DataLoader` override
      mechanism, which is already the right shape.
- [ ] Calibration: publish predicted-versus-observed data before any number here is
      described as assurance.
- [ ] Behavioral Diff Spec — a vendor-neutral format, with a reference implementation
      outside TypeScript.

## Explicitly not doing

Named so nobody spends effort proposing them:

- Prompt-injection or jailbreak filtering. That is what "guardrails" means in
  practice, it is a different product, and the incumbents have a multi-year lead.
- Runtime network mediation or action interception.
- Generic SAST. Semgrep and CodeQL have dataflow Veris does not.
- Owning execution: no browsers, VMs, sandboxes, CI infrastructure or test runners.
- A paid tier, license gating, or telemetry on by default.

## Contribute

Where outside help moves the needle most, in priority order:

1. **Entry-point detection** for a framework you know well. This is the v2.3 unlock.
2. **Labelled repositories** for the classification benchmark — the accuracy claim
   needs ground truth, not more rules.
3. **Probe provenance**: the 22 shipped probes are good and uncited. A probe backed by
   a public postmortem or CVE is worth ten that are not.
4. **Language adapters** for Python and Go.
5. **Calibration data**: incidents Veris flagged that actually broke, and incidents it
   missed. Both are useful; the second more so.

See [CONTRIBUTING.md](CONTRIBUTING.md). Strategic context in [docs/MOAT.md](docs/MOAT.md),
which is due a rewrite against the post-audit reality.
