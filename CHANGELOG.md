# Changelog

All notable changes to Veris (Behavioral Verification Infrastructure) will be documented in this file.

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
