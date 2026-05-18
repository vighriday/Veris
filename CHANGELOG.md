# Changelog

All notable changes to Veris (Behavioral Verification Infrastructure) will be documented in this file.

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
- `start:mcp` script for stdio execution under MCP clients (Claude Code, Cursor).

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
