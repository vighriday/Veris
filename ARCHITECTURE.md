# Veris Architecture

High-level overview of end-to-end architecture, built natively in TypeScript/Node.js.

## Core Data Flow

Veris operates as a stateless data pipeline transforming raw source code ASTs into probabilistically penalized confidence reports.

```text
[ Raw Source Code ]
        v  (ts-morph / Phase 1)
[ Entity Models ] (Files, Classes, Functions, Calls)
        v  (Phase 2)
[ Behavioral Graph ] (Nodes, Edges: DependsOn, Invokes)
        v  (Phase 3)
[ Risk Models ] (Blast Radius, Fragility, Diffs)
        v  (Phase 4)
[ Verification Plan ] (Structural, Behavioral, Adversarial Tiers)
        v  (Phase 5)
[ Confidence Engine ] (Penalized Scores, Unverified Assumptions)
        v  (Phase 6 / 7)
[ Reporting & Integrations ] (Markdown, HTML, MCP, CLI, CI/CD)
```

## System Components

### 1. Intelligence & Parsing (`src/engine/RepositoryIntelligenceEngine.ts`)

- Inspects repositories via `ts-morph`.
- Extracts classes, functions, imports, and `CallExpression` targets.
- Honors `SecurityBaselineConfig` ignore paths (zero-retention, air-gapped defaults).

### 2. Behavioral Graph (`src/engine/BehavioralGraphEngine.ts`)

- Maps AST entities to `NodeType` (Service, Method, Function).
- Emits `EdgeType.DependsOn` from imports and `EdgeType.Invokes` from call-expression resolution against the callable index.

### 3. Git Diff Driver (`src/engine/GitDiffDriver.ts`)

- Creates a detached `git worktree` at a base ref.
- Produces two real graph snapshots (`baseGraph` vs `headGraph`) for the Diff Engine.
- Falls back to a synthetic 70% slice when not in a git repo or no base ref exists.

### 4. Risk Assessment (`src/engine/RiskModelingEngine.ts` and `BehavioralDiffEngine.ts`)

- Diff engine computes added/removed nodes + edges and impacted set.
- Risk engine scores blast radius, integration count, dependency fragility, runtime criticality.
- Produces English explanations attached directly to each `RiskScore`.

### 5. Verification Planning and Confidence (`src/engine/VerificationPlanningEngine.ts`, `ConfidenceEngine.ts`)

- Maps risk vectors into Tier 1/2/3 verification targets and execution directives.
- Confidence degrades mathematically from risk averages and unexecuted target counts.

### 6. MCP Layer (`src/mcp/McpServer.ts`)

- Exposes the pipeline over Model Context Protocol stdio.
- Five tools: `analyze_repository`, `export_behavioral_graph`, `analyze_pr_behavior`, `generate_verification_plan`, `identify_unverified_behaviors`.

### 7. Execution Surfaces

- **CLI**: `dist/cli.js` accepts `--base-ref=<ref>` and `VERIS_CONFIDENCE_THRESHOLD` env for gating.
- **Dashboard**: Markdown + standalone interactive HTML written to `veris-reports/`.
- **GitHub Actions**: `.github/workflows/veris.yml` runs on PRs against `main`/`master` with full history.

## Extensibility

- DTO objects in `src/models/`. New languages or risk heuristics map to these schemas.
- `LanguageAdapter` interface (`ArchitectureModels.ts`) is the plugin contract for non-TS/JS ecosystems.
