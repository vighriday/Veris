# Veris — Behavioral Verification Infrastructure

Veris is a locally executing, stateless data pipeline that transforms raw source code Abstract Syntax Trees (ASTs) into probabilistically penalized confidence reports. It maps semantic code graphs, assesses blast-radius risks, and produces verification plans across structural, behavioral, and adversarial tiers.

It is designed to give engineering teams (and autonomous sub-agents) mathematical predictability around *why* a code change is risky and *what* must be executed to validate it, complying with zero-retention defaults.

## Core Features

- **Phase 1 — Repository Intelligence Engine**: Parses TypeScript/JS repos via `ts-morph`, extracting classes, functions, imports, and call expressions.
- **Phase 2 — Behavioral Graph Engine**: Builds graph nodes (Service/Method/Function) and emits `DependsOn` plus `Invokes` edges resolved against a global callable index.
- **Phase 3 — Behavioral Diff and Risk Modeling**: Real git-diff via temporary worktree against a base ref (synthetic fallback). Scores blast radius, fragility, runtime criticality.
- **Phase 4 and 5 — Verification Planning and Confidence**: Maps risks to Tier 1/2/3 directives; confidence degrades mathematically with unexecuted targets and high-risk averages.
- **Phase 6 — Reporting**: Markdown (`veris-report.md`) + interactive single-file HTML dashboard (`veris-dashboard.html`) under `veris-reports/`.
- **Phase 7 — MCP + CI**: MCP server over stdio (5 PRD tools) and a GitHub Actions workflow (`veris.yml`) that blocks PRs when confidence falls below threshold.

## Quick Start

### Install + Build

```bash
npm install
npm run build
```

### CLI

Run against current repo:

```bash
node dist/cli.js .
```

Run against a different repo, with explicit base ref:

```bash
node dist/cli.js ../my-other-project --base-ref=origin/main
```

Outputs land in `<target>/veris-reports/{veris-report.md, veris-dashboard.html}`.

CI gating: set `VERIS_CONFIDENCE_THRESHOLD=70` to fail with exit code 2 when confidence drops below 70.

### MCP Agent Usage

Veris exposes a Model Context Protocol server over stdio. Hook it into a compatible agent (Claude Code, Cursor):

```json
{
  "mcpServers": {
    "veris": {
      "command": "node",
      "args": ["C:/absolute/path/to/Veris/dist/mcp-index.js"]
    }
  }
}
```

Tool chain (state is cached across calls):

1. `analyze_repository`
2. `export_behavioral_graph`
3. `analyze_pr_behavior` — accepts optional `baseRef`; uses real git worktree diff when available.
4. `generate_verification_plan`
5. `identify_unverified_behaviors` — pass `executedTargetsCount`.

### Smoke Tests

```bash
npm run test:mcp:deep
```

## Architecture and Data Flow

```text
Raw Source -> AST Entities -> Behavioral Graph -> Diff (vs git base) -> Risk -> Verification Plan -> Confidence -> Reports / MCP
```

See `ARCHITECTURE.md` and `behavioral_verification_infrastructure_prd.md` for full specification.

## CI/CD Pipeline

`.github/workflows/veris.yml` runs on pull requests against `main`/`master`. It builds, executes the CLI with `--base-ref=origin/$github.base_ref`, and uploads `veris-reports/` as a build artifact. Set the `VERIS_CONFIDENCE_THRESHOLD` repo variable to enforce gating.
