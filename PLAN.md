# BVI Implementation Plan

## Phase 1: Foundation & Repository Intelligence Engine (PRD Sections 7, 10, 11.1, 13)
- **Init project structure:** (TypeScript/Node.js or Python) optimized for local-first execution (PRD 25).
- **Repository Intelligence Engine:**
  - Build incremental AST analysis and ingestion (PRD 11.1, 27).
  - Extract basic entities: files, classes, functions, routes, schemas (PRD 13).
  - Build dependency mapping (imports, module dependencies).
  - Framework adapters: Setup Plugin architecture to support TS/Python/Go ecosystems (PRD 23, 24).
- **Security & Privacy Baseline:** Ensure no sensitive data leak, define zero-retention/air-gapped modes (PRD 25, 26).

## Phase 2: Semantic Understanding & Behavioral Graph Engine (PRD 9.1, 11.2, 11.3, 16)
- **Semantic Understanding Engine:**
  - Infer intents, domains, and runtime behaviors.
  - Map workflow relationships, state dependencies, and contract dependencies (PRD 16).
- **Behavioral Graph Engine:**
  - Build core graph data structure representing the "Verification Surface" (PRD 9.2).
  - Map entities (services, routes, workflows, APIs, databases) as nodes.
  - Map relationships (mutates, invokes, synchronizes) as edges.
  - Ensure partial graph recomputation to handle large monorepos (PRD 27).

## Phase 3: Behavioral Diff & Risk Modeling (PRD 9.3, 11.4, 11.5, 18)
- **Behavioral Diff Engine:**
  - Compute semantic diffs between codebase states (PRD 9.3).
  - Detect semantic regressions, impacted workflows, indirect dependency risks.
- **Risk Modeling Engine:**
  - Implement scoring for Blast Radius, Runtime Criticality, State Mutation Density, Integration Count, etc. (PRD 18).
- **Explainability Layer:** Explain *why* behaviors are risky to avoid black-box UX (PRD 21).

## Phase 4: Verification Planning & Confidence Engine (PRD 9.4, 9.5, 11.6, 11.7, 17)
- **Verification Planning Engine:**
  - Implement Tier 1 (Structural), Tier 2 (Behavioral), and Tier 3 (Adversarial) verification planning targets (PRD 9.5).
  - Generate structured validation directives consumed by CI/external agents.
- **Confidence Engine:**
  - Build confidence scoring formula based on verification completeness, workflow criticality, historical instability, and execution depth (PRD 17).
  - Output Explainable confidence metrics.

## Phase 5: MCP Integration & External Agent API Layer (PRD 11.8, 12, 19)
- **MCP Integration Layer:**
  - Implement standard Model Context Protocol server.
  - Build specific MCP functions (PRD 12):
    - `analyze_repository()`
    - `analyze_pr_behavior()`
    - `generate_verification_plan()`
    - `identify_unverified_behaviors()`
    - `export_behavioral_graph()`
  - Verify compatibility with Claude Code, Cursor, CI pipelines, and GitHub Actions (PRD 19).

## Phase 6: Reporting and Dashboard (PRD 14, 15, 20)
- **Structured & Human-Readable Outputs:**
  - Generate Markdown, HTML reports, and PR comments (PRD 14).
- **Dashboard Implementation:**
  - Build dashboard sections: Repository Health, Workflow Risk Map, Behavioral Diff Viewer, Confidence Timeline, etc. (PRD 15).
  - Focus UX on Trust, Explainability, and Actionability (PRD 20).

## Phase 7: Continual Extensibility & Open Source (PRD 22, 23, 31)
- Refine Plugin Architecture for custom risk/confidence models and enterprise policy engines (PRD 23).
- Establish framework for community-contributed graph enrichers and verification heuristics (PRD 22).
