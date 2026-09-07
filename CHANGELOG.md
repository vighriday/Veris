# Changelog

All notable changes to Veris (Behavioral Verification Infrastructure) will be documented in this file.

## [Unreleased] — Foundation audit

A full architecture audit produced 52 confirmed findings, tracked in
[`docs/internal/BUG_TRACKER.md`](docs/internal/BUG_TRACKER.md). This release addresses
them. Several were severe enough that output from earlier versions should not be
relied on; those are called out below.

### Breaking, and why

- **No synthetic baseline.** When git was unavailable, every prior version built a
  fake "before" state from the first 70% of the current graph and reported the
  comparison as a real behavioural diff, with no flag distinguishing it. All five
  call sites are removed. A run that cannot establish a baseline now **fails** —
  CLI exit code 3, an explanatory MCP error — instead of inventing one.
  **Any diff produced by an earlier version outside a git repository was fabricated.**
- **Plugins no longer execute by default.** `<repo>/.veris/plugins/*.js` was
  `require()`d automatically, without a sandbox, and the load was reachable from
  read-shaped MCP tools. Pointing an agent at an untrusted repository executed that
  repository's code. Execution now requires `--allow-plugins` or
  `VERIS_ENABLE_PLUGINS=1`, and each executed plugin is disclosed with its SHA-256
  first. `VERIS_PLUGINS_DISABLED` is gone — the default is now off.
- **Node ids are repository-relative** (`src/auth/login.ts::signIn`), not absolute
  paths. Fingerprints, state rows and MCP output all change shape. Existing
  `.veris/state.db` files migrate automatically to schema v2; history recorded under
  absolute ids will not match new ids.
- **`overallConfidence` is now evidence coverage.** It no longer encodes risk. With
  no execution history the old value was structurally confined to `[10, 45]`
  regardless of the repository, and had never been calibrated against outcomes.
  Prefer the new named fields on `identify_unverified_behaviors`.
- **`package.json` `main` is a real module.** `src/index.ts` was a self-executing
  demo, so `require('veris-core')` ran a full repository scan and wrote report files
  as an import side effect. It now only exports.

### Fixed — baseline integrity

- Compare against `git merge-base HEAD <ref>` rather than the ref's tip. Diffing
  against the tip reported commits others merged after your branch was cut as
  behaviour **your** branch removed.
- Restrict analysis to `git ls-files`. Untracked and ignored files counted as added
  behaviour — 12,438 phantom additions on this repository alone.
- The base snapshot no longer rewrites paths. The previous rewrite updated
  `filePath` but not the parallel dependency map the graph builder read, so **the
  base graph lost every import edge on every run**, and the entire import structure
  was reported as newly added each time.
- A working-tree analysis is labelled `<sha>-dirty` with a file count, instead of
  claiming commit-to-commit provenance for a comparison that included uncommitted
  edits.
- Ignore globs anchored as `**/<dir>/**`. Nested `node_modules` and vendored trees
  were parsed as first-party source: **1,667 of 1,735 analyzed files on this
  repository were third-party.**

### Fixed — graph accuracy

- **Call targets are resolved through the TypeScript checker.** Previously the callee
  was `getText().split('.').pop()` matched against a global name index, emitting an
  edge to *every* declaration sharing that trailing name — so `console.log()` created
  an edge to the project's own `Logger.log`. Measured against the MCP SDK, **2,804 of
  3,077 `Invokes` edges (91.1%) pointed at an ambiguous name.** An ambiguous call now
  produces no edge, and every edge carries `resolution`
  (`resolved` / `heuristic` / `structural`).
- Import specifiers are extension-normalized, so `from './target.js'` matches.
  ESM/NodeNext repositories previously produced **zero** import edges.
- Constructors, getters and setters are extracted. A class whose logic lives in its
  constructor contributed no nodes and no calls at all.
- Function extraction is genuinely restricted to top-level declarations, as the
  existing comment had claimed; callbacks and closures no longer become graph nodes.
- Edge diffing includes the edge type and uses set membership: a `DependsOn` and an
  `Invokes` between the same pair no longer collide, and the diff is no longer O(n²).
- Nodes carry a normalized `bodyHash`, and the diff reports `modifiedNodes` — a
  declaration rewritten while keeping its name and callees. Fingerprints include it,
  so the "silent rewrite" case the drift detector claimed to catch is now actually
  detected, while a directory rename no longer reports 100% drift.
- Drift iterates the union of previous and current workflows, so a **deleted**
  workflow is reported. Previously, deleting an entire workflow printed
  "No workflow drift detected."

### Fixed — scoring honesty

- Risk uses three genuinely independent inputs. 65% of the old score was node degree
  counted twice (a linear term plus a log of the same scalar), and the linear term
  saturated at degree 13, so a 13-edge node and a 500-edge node scored identically.
  Class-to-own-member containment edges no longer inflate degree.
- Risk is summarized by maximum, not mean: adding harmless files used to dilute a
  dangerous one and improve the reported position.
- Flaky results earn no credit (they previously earned half credit *and* took a
  penalty in the same branch). Failure penalties decay symmetrically with passes.
  Zero planned targets reports coverage as *unknown*, not 100%. Full coverage no
  longer prints "penalized due to missing coverage (depth 100.0%)".
- `executedTargetsCount` works. It was documented on the MCP tool, hardcoded to 0 on
  the CLI path, and unreachable on the MCP path.
- Planning thresholds moved into `data/risk-config.json` under `planning`.
  `RiskModelingEngine`'s header claimed no thresholds were hardcoded while
  `VerificationPlanningEngine` hardcoded all four.
- Probes spread across the riskiest members of a workflow instead of pinning every
  probe to one anchor node, and the dead `minRiskThreshold` default (below the risk
  formula's own floor) is now a real threshold.

### Fixed — evidence integrity

- **Execution evidence is append-only and hash-chained.** It was written with
  `INSERT OR REPLACE` keyed on `(run_id, node_id, tier)` with one run id per process,
  so a caller could post `fail` and then erase it with `pass`. Each row now carries a
  producer identity and a trust class (`veris-derived` / `harness-observed` /
  `agent-asserted`), and `verifyEvidenceChain()` detects rows edited or deleted
  directly in the database.
- Coverage weights `agent-asserted` evidence at half, and a more-trusted failure wins
  over a less-trusted later pass — an agent cannot raise its own assurance by
  asserting harder.
- Real numbered schema migrations, applied transactionally. `migrate()` was
  `CREATE TABLE IF NOT EXISTS` plus a comment, which is a no-op on an existing
  database; adding a column would have hard-crashed every existing user.
- `learned_signals` dropped — zero rows, zero callers. `node_history` is now read by
  the `node_history` tool, which had promised risk-over-time and returned executions.

### Fixed — MCP surface

- Tool arguments are **validated** against their declared schemas before dispatch. The
  low-level MCP server does not do this, so `required` and `enum` were decoration.
- Every list-shaped response is capped and reports `truncated: { shown, total }`.
  The plan response measured **12.28 MB** and `allocate_budget` returned the
  *complement* of its selection, reaching **16.3 MB** — enough to exhaust an agent's
  context window before any of it could be read.
- The analysis cache is invalidated on source mtime. It was held for the process
  lifetime, so in the core "agent edits code, then asks what changed" loop **every
  answer after the first edit was stale**, with no indication.
- Runs and fingerprints are persisted from the MCP path. They were written only from
  the CLI, so under MCP `detect_drift` reported "first observation" forever and
  `confidence_history` returned `[]` forever.
- Derived caches reset together, so `generate_verification_plan` can no longer return
  the previous diff's plan.
- `report_execution` batches are transactional and validated; an unknown `tier` no
  longer returns `recorded: 1` while having no effect.
- Eight tool descriptions corrected to match their handlers — agents select tools by
  reading these, so a description that overstates its handler causes wrong tool
  selection.
- The database is checkpointed and closed on shutdown (the WAL had reached 4.1 MB
  against a 282 KB database), and the server reports the real package version.

### Fixed — reporting and output size

- The dashboard pins `vis-network@9.1.9` with a verified SRI hash and `crossorigin`,
  replacing an unpinned CDN reference with no integrity check. README's "No network
  calls" and "Single-file HTML" claims are corrected.
- All source-derived strings are HTML-escaped at every interpolation site.
- Unverified assumptions are deduplicated and capped. This loop emitted one string per
  qualifying node with no limit: **5,947 identical sentences, 98% of the markdown
  report.**

### Fixed — packaging and CI

- `veris analyze` works. `analyze` was not a recognized subcommand and fell through to
  the path parser, so it analyzed `./analyze`, found nothing, printed
  "Reports generated" and exited 0 — the exact invocation `skill.json` advertises.
- `node_modules` untracked: **4,432 of 4,548 tracked files**, stale, and missing
  `vitest`, so a fresh clone could not run the test suite.
- The MCP integration check asserts. It previously branched on whether a response id
  matched and never inspected `error` or `isError`, so it could not fail. It now
  drives the full tool surface, checks response shapes, enforces a size ceiling, and
  verifies that invalid arguments are rejected.
- CI gates on `tsc --noEmit` and coverage, adds Windows to the matrix (native
  `better-sqlite3`, plus a shipped Windows-specific MAX_PATH path), and asserts
  ceilings on generated report sizes.
- Coverage measures all of `src/`, not only `src/engine/**` — the excluded files
  (MCP server, persistence, reporting, CLI, plugin loader) were all at 0%.
- Release publishes from a tagged GitHub Actions workflow with npm provenance.
  `prepublishOnly` now typechecks and tests.

### Added

- `docs/internal/BUG_TRACKER.md` — the audit findings with reproduction detail and
  proposed fixes.
- README "Honest limits" section: what Veris does not do, stated plainly.
- **232 tests** across 20 files (from 55 across 12), including the first coverage of
  `RepositoryIntelligenceEngine`, `GitDiffDriver`, `VerisState`, `PluginLoader`,
  `ReportingEngine`, `CrossRepoRegistry` and the MCP schema layer — all previously at
  0%. Real git repositories and real temp files, not mocks.
- `AnalysisStats` on every report: files analyzed/skipped and call-resolution counts,
  so ambiguity is visible rather than hidden.

### Measured on this repository (HEAD~1 baseline)

| | before | after |
|---|---|---|
| Dashboard | 156,306,026 B | ~406 KB |
| Markdown report | 1,264,183 B | ~5 KB |
| Report lines | 6,043 | 98 |
| Verification targets | 29,357 | 162 |
| Call resolution | 91% ambiguous | 97.1% resolved, 0 ambiguous |
| Files analyzed | 1,735 (1,667 third-party) | 116 tracked |
| Tests | 55 | 232 |

## [2.1.8] - 2026-05-19 — "skills.sh"

### Added

- **skills.sh / vercel-labs/skills integration**: `skills/veris/SKILL.md` so any agent can install Veris via `npx skills add vighriday/Veris`.
- `skills/` directory included in npm tarball.
- `server.json` included in npm tarball (for MCP Registry consumers).

## [2.1.7] - 2026-05-19 — "MCP Registry"

### Added

- **MCP Registry metadata**: `mcpName` field in `package.json` (`io.github.vighriday/veris`) + top-level `server.json` so Veris can be published to the official Model Context Protocol Registry at https://registry.modelcontextprotocol.io.

No code changes — pure registry metadata.

## [2.1.6] - 2026-05-18 — "OSS shakedown"

Ran Veris against Prisma (3,696 nodes), NestJS (3,712 nodes), and Strapi (6,982 nodes). Three real bugs surfaced. All fixed.

### Fixed

- **Windows MAX_PATH crash**: on large repos (Prisma) with deeply nested paths, `git worktree add` aborts because file paths exceed 260 chars. Veris was bubbling the failure as a fatal CLI error. Now catches the error, prunes the partial worktree, and falls back to synthetic diff with a clear log line.
- **AI classifier false positives**: path tokens `prompt`/`agent`/`ai` and symbol tokens `prompt`/`chat`/`tool` were too broad. They caught Prisma's CLI prompt scaffolding (`prompt/utils/`, `promptTemplateSelection`) and NestJS's GraphQL chat sample apps. Tightened to `llm`/`rag`/`embedding`/`completion` path tokens and `completion`/`embed` symbol tokens. Removed `ts-morph` from import tokens (Veris was self-classifying as AI).
- **Test/sample/fixture deweight**: code under `__tests__/`, `tests/`, `samples/`, `examples/`, `fixtures/`, `e2e/`, `benchmarks/`, or files matching `*.test.ts` / `*.spec.ts` now contribute 30% signal weight instead of 100%. Real `src/auth/login.ts` always outranks `tests/auth.spec.ts` when scoring. Scoped to relevant path segments (after the source anchor) so a project rooted at `examples/demo-app/` is not deweighted as a whole.

### Verified

| Repo | Nodes | Edges | Workflows | Probes | Notes |
|------|-------|-------|-----------|--------|-------|
| Prisma | 3,696 | 25,046 | 13 | 21 | Persistence dominant (correct — ORM). AI false positives: 12 → 0. |
| NestJS | 3,712 | 31,890 | 14 | 21 | Routing dominant (correct — router framework). AI false positives: 2 → 0. |
| Strapi | 6,982 | 40,027 | 21 | 25 | Admin dominant (correct — CMS). 22 → 21 workflows after AI false-positive removal. |
| demo-app | 37 | 16 | 11 | 18 | No regression — all 11 planted workflows still classify correctly. |

## [2.1.5] - 2026-05-18 — "Demo-app shakedown"

A self-contained demo app (`examples/demo-app/`) with planted bugs across 11 workflows surfaced six real Veris defects. All fixed in this release.

### Fixed

- **GitDiffDriver subpath leakage**: when `projectRoot` is a subdir of a larger git repo, the base-ref worktree analysis crawled the entire parent tree, so risk/probe output was contaminated with unrelated nodes. Base analysis is now scoped to the same relative subpath as `projectRoot`.
- **BehavioralDiffEngine added stale nodes** to `impactedNodes` by falling back to `oldNodesMap.get(...)` for removed-edge sources. Deleted-module tombstones leaked into risk scoring. Now strictly head-graph only.
- **Isolated added nodes** (a brand-new file whose only imports are external packages) were dropped from `impactedNodes` because no graph edge touched them. Every added node is now impacted by definition.
- **AdversarialProbeGenerator emitted per-node**, so three Auth nodes meant three duplicate copies of each Auth probe — while Caching, AI, Notifications, etc. got zero probes because no member crossed the risk threshold. Refactored to emit a deduped probe deck per workflow anchored to the workflow's highest-risk member.
- **Classifier camelCase blind spot**: `matchesSymbol` used a strict regex word-boundary, so `issueSession` did not match symbolToken `session`. Now splits camelCase into components first.
- **Path-token weight vs import-token weight**: a file in `payments/` that imports `ioredis` was tied between Payments and Caching. Path-token match strength is now tiered (exact segment = strongest, prefix = medium, scoped = weakest) and exact segment outranks any import-token.

### Added

- **`examples/demo-app/`**: self-contained synthetic TS/JS app with 17 planted bugs across Authentication, Session, Payments, Checkout, Webhooks, Caching, Queue, Persistence, Routing, AI, Notifications. `GROUND_TRUTH.md` lists every planted issue and the probe Veris must fire to catch it.
- **`examples/runs/demo-app-snapshot.md`**: writeup of the run, the ground-truth diff, and the six Veris bugs this exercise surfaced.

### Verified

Running `npx veris-core examples/demo-app` now flags all 11 expected workflows, generates 18 probes covering every workflow kind, and produces zero false-scope leakage from the parent Veris repo.

### Fixed (dashboard)

- Generated-at timestamp rendered as hardcoded `UTC` regardless of viewer's machine. Now uses `Intl.DateTimeFormat` with viewer's local timezone; hover tooltip shows source UTC for reference.

## [2.1.4] - 2026-05-18 — "Real-world hardening"

### Fixed — caught by testing on Express + Next.js

- **CommonJS coverage**: Express has 141 files but v2.1.3 only saw 55 nodes / 8 edges because ts-morph `getClasses`/`getFunctions` skip `module.exports.X = function() {}` patterns. New `RepositoryIntelligenceEngine` extracts:
  - `require('...')` calls (was only catching ES `import`)
  - `const X = function() {}` and `const X = () => {}` top-level assignments
  - `module.exports.X = function() {}` and `exports.X = function() {}` patterns
  - `module.exports = function() {}` named after the file basename
  - `Foo.prototype.bar = function() {}` prototype methods grouped under the class
  - Result on Express: 93 nodes (+69%), 71 edges (+787%), 6 workflows detected (was 3, including correct Routing/Authentication/Session/Caching identification).
- **Edge explosion on monorepos**: Next.js (2444 files) produced 545,762 edges in v2.1.3 due to basename-collision matching every `index.ts` to every other `index.ts`. Now:
  - Only resolves edges for imports that look local (`./`, `../`, `/`, `~/`, `@/`, `$/`)
  - Skips basenames shared by more than 5 files (e.g. `index`, `utils`, `helpers`)
  - Edge dedup so the same `(source, target, type)` triple counts once
- **Perf**: `BehavioralGraphEngine` no longer does O(N²) file lookups. Pre-indexed by basename. Next.js graph build dropped from un-runnable to sub-second.

### Added

- **Dashboard payload schema version** (`schemaVersion: "1.1.0"`) embedded in every dashboard. Downstream consumers can pin / validate.
- **Friendlier CLI errors**: hints for missing `better-sqlite3`, missing git, missing `data/` files. `VERIS_DEBUG=1` for full stack.
- **SQLite migration safety**: warns when an existing `.veris/state.db` was written by a newer schema.
- **Plugin loader validation**: rejects malformed `addWorkflowRule`, `addRuntimeRisks`, `addRiskHeuristic`, `addLanguageAdapter` calls with a clear log instead of silently corrupting state.
- **`.tsx`, `.jsx`, `.mjs`, `.cjs` file extensions** now ingested by RepositoryIntelligenceEngine.

### Changed

- TypeScript project loads with `compilerOptions: { allowJs, checkJs: false, noEmit, skipLibCheck }` — skips type checking for massive perf win on JS-heavy repos.

## [2.1.3] - 2026-05-18 — "Data-driven, accuracy fixes"

### Fixed (accuracy bugs in classifier — found by self-audit)

- Workflow classifier used naive substring matching on file paths, so `Users` matched `user` (Profile false positive across all Windows paths), `Planning` matched `plan` (false Billing), `index.ts` matched `index` (false Search), `RepositoryIntelligenceEngine` matched `repository` (false Persistence).
  - Switched to path-segment matching with a prefix-with-short-suffix rule (`report` matches `reporting`/`reports` but not `replication`).
  - Switched symbol matching to identifier word boundaries (no more `export` matching every exported symbol).
  - Dropped over-generic tokens: `user`, `plan`, `index`, `export`, `create`/`update`/`delete`.
- RiskModelingEngine: replaced binary 80/20 fragility scoring with a log2 curve. Replaced "`label contains 'Engine' or 'auth'`" criticality with a multi-signal score (pattern + path + identifier hints).
- Self-audit on the dashboard payload confirmed 130/130 graph nodes and 345/345 edges point to real source — no fabricated data.

### Changed — everything externalized

- Workflow rules moved to `data/workflow-rules.json` (25 default rules across 28 kinds).
- Runtime-risk catalog moved to `data/runtime-risks.json` (18 workflow kinds with curated risk hypotheses).
- Adversarial probe templates moved to `data/probes.json` (15 workflow kinds with concrete scenarios + invariants, plus generic probes).
- All risk math constants, confidence weights, tier costs, and workflow criticality multipliers moved to `data/risk-config.json`.
- `src/data/DataLoader.ts` resolves package defaults and merges per-repo overrides from `<project>/.veris/data/*.json`. Deep-merge for objects; array files take optional `extend: true` flag.
- Every engine that previously had inline constants (`WorkflowClassifier`, `RiskModelingEngine`, `AdversarialProbeGenerator`, `VerificationBudgetAllocator`, `ConfidenceEngine`, `CounterfactualEngine`) now accepts a `projectRoot` and reads from the data layer.

### Added

- `ROADMAP.md` linked from the README, skill.json, mcp-server.json.
- `assets/logo.png` and a centered hero block at the top of the README.
- `data/` directory included in the npm tarball (added to `package.json#files`).

## [2.1.2] - 2026-05-18

### Changed

- Vendor-neutral sweep: removed `claude-code` and `cursor` from package.json keywords, skill.json keywords, mcp-server.json tags. Replaced with `mcp-client` / `coding-agent`.
- Dashboard verification-targets card heading: "send directive to Claude" → "send directive to your agent".
- Git history pruned: filter-branch backup refs (`refs/original/*`) deleted and aggressive GC removed dangling commits carrying old co-author trailers.

## [2.1.1] - 2026-05-18

### Fixed

- `npx veris-core` failed with "could not determine executable to run" because the package exposed only `veris` and `veris-mcp` bins. Added a `veris-core` bin alias pointing to the CLI so every README command works directly.

## [2.1.0] - 2026-05-18 — "Public-ready"

### Security

- **Shell injection fixed**: `GitDiffDriver` now uses `execFileSync` exclusively (no shell). User-supplied `--base-ref` validated against a strict allowlist regex; refs containing `..`, whitespace, or shell metacharacters are rejected.
- **XSS hardening**: dashboard JSON payload escapes `</script` and U+2028/U+2029 line terminators when embedded in inline `<script>` tag.
- **Repository hygiene**: untracked `node_modules` from initial commit (4,432 files removed from tracked tree).
- **Co-authored-by trailers** stripped from all historical commits via filter-branch.

### Added — CLI subcommands

- `veris doctor` — health check (Node, git, deps, plugins, state).
- `veris schema` — print public JSON Schemas for MCP tool outputs.
- `veris version` — print version.
- `veris mcp` — start MCP server (equivalent to `npx veris-core mcp`).
- `--watch` — debounced re-run on file changes (fs.watch with polling fallback).
- `--quiet` / `-q` — reduce log output.

### Added — Dashboard UX

- **Executive Summary band** at the top — prose verdict + workflow risk highlights + drift summary + next action.
- **Sticky filter banner** with Clear button when a workflow filter is active. **Escape** clears.
- **Export buttons** — download dashboard payload as JSON or targets+probes+risks as CSV.
- **Top action bar** — Docs link, project meta visible.
- **Tier legend + info tooltips** on Tier 1/2/3 stat cards.
- **Keyboard hint** in bottom-left.

### Added — Marketplace + OSS files

- `skill.json` — skills.sh manifest with MCP wiring, env vars, permissions, privacy claims.
- `mcp-server.json` — MCP registry manifest with categorized tool list.
- `.npmignore` — publish-clean package.
- `SECURITY.md` — threat model + reporting flow.
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1.
- `.github/ISSUE_TEMPLATE/{bug,feature,config}` — structured issue forms.
- `.github/PULL_REQUEST_TEMPLATE.md` — checklist + test plan.
- `.gitattributes` — LF line endings.
- `src/schema/PublicSchema.ts` — JSON Schemas for `RiskScore`, `WorkflowAggregate`, `ConfidenceReport`, `AdversarialProbe`, `DriftReport`.

### Changed

- **CI matrix**: tests on Node 18 / 20 / 22 with doctor + CLI smoke + MCP deep-chain test + artifact upload.
- Package marked `publishConfig.access=public` with proper `bin`, `files`, `engines`, `repository`, `bugs`, `homepage`, `types`.
- README rewritten around plug-and-play install paths (MCP one-liner, CLI npx, source).
- `bin` now also exposes `veris-mcp` for direct MCP-server invocation.

## [2.0.0] - 2026-05-18 — "Intelligence Layer"

### Added — engines

- **VerisState (SQLite layer)** at `.veris/state.db`. Persistent run history, executions, fingerprints, node risk history, learned signals. WAL journal mode. `VERIS_STATE_DISABLED=1` to skip writes entirely (zero-retention).
- **Confidence half-life decay**: `ConfidenceEngine` consumes real `executions` history with exponential decay (default 14-day half-life). Failed executions actively reduce confidence; flaky executions count for half-credit. Tier-weighted (T3 buys 4× the confidence of T1).
- **Workflow fingerprinting**: `WorkflowFingerprintEngine` produces SHA-256 fingerprints of each workflow's member set + internal edge topology.
- **Drift detector**: `DriftDetector` compares current fingerprints to history. Detects silent rewrites (same members, different topology), surface expansion/contraction, and oscillating refactors.
- **Counterfactual mode**: `CounterfactualEngine.whatIfRevert(nodeIds)` simulates removing nodes from head graph and recomputes diff + risk. Returns delta + avoided risks + narrative.
- **Adversarial probe generator**: `AdversarialProbeGenerator` emits concrete Tier 3 hypotheses per workflow kind — idempotency, retry storms, replay attacks, cache stampede, partial failure, ordering, auth edges, malformed state, concurrency. Each probe has a scenario + expected invariant.
- **Verification budget allocator**: `VerificationBudgetAllocator` greedy knapsack on (tier × workflow criticality × risk) / cost. Picks highest-leverage subset of targets within a time budget.
- **Onboarding exporter**: `OnboardingExporter` writes a workflow-first markdown map under `veris-reports/onboarding/` — one file per workflow with members, internal topology, runtime risks, and a "where to start reading" fan-in hub.
- **Cross-repo registry**: `CrossRepoRegistry` at `~/.veris/registry.json`. Register repos by name; query latest run + confidence across the fleet.
- **Plugin loader**: `.veris/plugins/*.js` modules export `register(api)` to add workflow rules, runtime risks, risk heuristics, and language adapters. `VERIS_PLUGINS_DISABLED=1` to skip.

### Added — MCP tools (10 new, 17 total)

- `list_workflows`, `analyze_workflow` (v1.2 already), plus:
- `detect_drift`, `generate_adversarial_probes`, `allocate_budget`, `what_if_revert`, `report_execution`, `confidence_history`, `node_history`, `export_onboarding`, `cross_repo_snapshot`, `register_repo`.

### Added — dashboard

- **Confidence Heatmap** — workflow cells colored by max risk; click to filter.
- **Confidence Over Time** — SVG sparkline of confidence trend across runs.
- **Behavioral Drift card** — narrative-driven; flags silent rewrites + oscillation.
- **Adversarial Probes card** — filterable by node/severity. Click-to-copy individual probe prompts; "Copy ALL filtered probes" batch button.
- **Verification Budget card** — live what-if: change the minute budget, the allocator recomputes the selected subset client-side and lets you copy the plan as a prompt.

### Added — CLI

- `veris init` scaffolds `.veris/` with `plugins/`, `config.json`, sample disabled plugin.
- `veris help` prints usage.
- `--budget=<minutes>` flag drives the budget allocator card.
- `--onboarding` flag writes the onboarding map.

### Added — OSS files

- `LICENSE` (MIT).
- `CONTRIBUTING.md`.
- `docs/PLUGINS.md` — plugin guide with API reference + examples.
- `docs/MCP_TOOLS.md` — MCP tool reference + recommended flows.
- `examples/plugin-fintech.js` — vertical reinforcement plugin sample.

### Changed

- `RepositoryIntelligenceEngine` honors plugin language adapters (interface in place; built-ins still TS/JS).
- `ConfidenceEngine.calculateConfidence` gains `opts: { state, halfLifeDays, nodeWorkflowMap }`; old signature still works.
- Dashboard payload extended (`drift`, `fingerprints`, `probes`, `budget`, `confidenceTrend`, `pluginsLoaded`, `runId`).
- Package bumped to `2.0.0`. MCP server `version` field bumped to `1.2.0` (kept in sync with workflow features).

## [1.2.0] - 2026-05-18

### Changed

- **Project rebranded BVI -> Veris.** Affects:
  - Package name: `bvi-core` -> `veris-core`.
  - CLI binary: `bvi` -> `veris`.
  - Env var: `BVI_CONFIDENCE_THRESHOLD` -> `VERIS_CONFIDENCE_THRESHOLD`.
  - Output dir: `bvi-reports/` -> `veris-reports/` (artifact filenames: `veris-report.md`, `veris-dashboard.html`).
  - CI workflow file: `.github/workflows/bvi.yml` -> `.github/workflows/veris.yml`.
  - MCP server identifier in code: `BviMcpServer` -> `VerisMcpServer`; protocol name `bvi-mcp-server` -> `veris-mcp-server`.
  - Code identifiers: `BVIFile/BVIClass/BVIFunction` -> `VerisFile/VerisClass/VerisFunction`.
  - Dashboard titles and clipboard prompts updated.
- PRD file (`behavioral_verification_infrastructure_prd.md`) left untouched — that is the original spec doc; "BVI" there is the original concept name.

### Added

- **Interactive single-file dashboard** (`veris-dashboard.html`). Embeds full payload as JSON. Sections: confidence gauge (SVG ring), repo health stats, verification coverage (Tier 1/2/3 counts), Workflow Risk Map (vis-network graph, drag/zoom/hover), behavioral diff with expandable added-node list, unverified assumptions, confidence reasoning, sortable+filterable risk table, filterable verification targets with **click-to-copy directives**, batch "Copy ALL filtered as prompt" button.
- `ReportingEngine.generateDashboard(payload)` produces the interactive view; old `generateHtmlReport(md)` retained for compatibility.
- `ReportMeta` includes `projectRoot` and `generatedAt`.

## [1.1.0] - 2026-05-18

### Added

- **Real git-diff driver** (`src/engine/GitDiffDriver.ts`). Creates a detached `git worktree` at a base ref, analyzes both base and head trees, and produces two real graph snapshots for the diff engine. Falls back to synthetic 70% slice when no base ref / not a git repo.
- **Call-expression edge inference**: `RepositoryIntelligenceEngine` now extracts `CallExpression` callees. `BehavioralGraphEngine` resolves them against a callable index and emits `EdgeType.Invokes` edges between methods/functions (not just import-level `DependsOn`).
- **Security baseline enforcement**: `RepositoryIntelligenceEngine` honors `SecurityBaselineConfig.ignoredPaths` (defaults: `node_modules`, `dist`, `.git`, `veris-reports`, `bvi-reports`, `coverage`, `.next`, `build`). Zero-retention + air-gapped flags default to `true`.
- **CLI argument parsing**: `--base-ref=<ref>` to pin the diff base; `VERIS_CONFIDENCE_THRESHOLD` env to fail the run with exit code 2 when confidence drops below threshold.
- **Clean markdown -> HTML renderer**. Replaces the regex-chain that produced malformed lists.
- **MCP `analyze_pr_behavior`** accepts `baseRef` and uses the real git driver when possible. Response includes `diffMode`, `baseRef`, `headRef`.

### Changed

- CI workflow modernized: `actions/checkout@v4`, `actions/setup-node@v4` (Node 20 + npm cache), `actions/upload-artifact@v4`. CLI invocation uses `--base-ref=origin/$github.base_ref`.
- `VerisFunction` model gains optional `calls: string[]`.
- Test scripts moved from `src/test-mcp*.ts` to `tests/`. New npm scripts: `test:mcp`, `test:mcp:deep`, `cli`.
- `.gitignore` rewritten (was corrupted UTF-16) to plain UTF-8.

## [1.0.0] - Initial Release

### Phase 7 — CI/CD and CLI

- `src/cli.ts` enables terminal execution of the full Veris pipeline.
- `bin` field in `package.json` exposes `veris` command.
- GitHub Actions workflow blocks PRs on failed execution.

### Phase 6 — Reporting and Dashboards

- `ReportingEngine.ts` compiles risk, confidence, and verification plan into executive summaries.
- Markdown generation under `veris-reports/veris-report.md`.
- Static HTML dashboard under `veris-reports/veris-dashboard.html`.

### Phase 5 — MCP Integration

- `@modelcontextprotocol/sdk` wired in.
- `McpServer.ts` registers the five PRD tools.
- `start:mcp` script for stdio execution under any MCP-compatible client.

### Phase 4 — Verification Planning and Confidence

- `VerificationModels.ts` types Tier 1 (Structural), Tier 2 (Behavioral), Tier 3 (Adversarial).
- `VerificationPlanningEngine.ts` maps risk profiles into targets and execution directives.
- `ConfidenceEngine.ts` penalizes for unverified assumptions and partial execution depth.

### Phase 3 — Behavioral Diff and Risk Modeling

- `RiskModels.ts` defines risk-score, explanation, and diff schemas.
- `BehavioralDiffEngine.ts` computes deltas between two graph snapshots.
- `RiskModelingEngine.ts` produces blast-radius, fragility, criticality with English explanations.

### Phase 2 — Semantic Understanding and Behavioral Graph

- Graph nodes (`Service`, `Method`, `Function`).
- `DependsOn` edges derived from import paths.

### Phase 1 — Repository Intelligence Engine

- `ts-morph`-based AST parsing for TS/JS.
- Entity models: `VerisFile`, `VerisClass`, `VerisFunction`, `RepositoryIntelligenceReport`.

### Planning Artifacts

- `PLAN.md` mapping each PRD section to implementation phases.
- `ARCHITECTURE.md` outlining plugin architecture, security constraints, zero-retention.
