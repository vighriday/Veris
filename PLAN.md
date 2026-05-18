# Veris Implementation Plan

Phase-by-phase build plan. Each phase ships an end-to-end vertical slice — a usable feature, not infrastructure.

## Phase 1: Repository Intelligence Engine

- TypeScript/Node.js, local-first execution.
- AST analysis and ingestion via `ts-morph`.
- Extract entities: files, classes, functions, imports, call expressions.
- Build file-level dependency map.
- Framework adapters via plugin architecture (TS/JS today; Python/Go/Rust pluggable).
- Security baseline: zero-retention mode, air-gapped option, ignore-paths config.

## Phase 2: Semantic Understanding & Behavioral Graph

- Workflow inference: domain clustering, state dependencies, contract relationships.
- Graph data structure for the verification surface.
- Nodes: services, routes, workflows, APIs, databases, queues.
- Edges: depends-on, invokes, mutates, synchronizes.
- Partial graph recomputation for large monorepos.

## Phase 3: Behavioral Diff & Risk Modeling

- Diff engine over two graph snapshots (real git-worktree or synthetic fallback).
- Detect semantic regressions, impacted workflows, indirect dependency risks.
- Risk scoring: blast radius, runtime criticality, state mutation density, integration count, dependency fragility.
- Explainability layer: English explanations attached to every risk score.

## Phase 4: Verification Planning & Confidence Engine

- Tier 1 (Structural), Tier 2 (Behavioral), Tier 3 (Adversarial) verification targets.
- Structured validation directives consumed by external execution systems.
- Confidence scoring: verification completeness, workflow criticality, runtime uncertainty, execution depth.
- Half-life decay over real execution history.

## Phase 5: MCP Integration & External Agent API

- Standard Model Context Protocol server over stdio.
- 17 tools covering ingest, diff, plan, semantic, drift, counterfactual, verification, feedback, history, fleet.
- Compatible with any MCP-compatible coding agent, CI pipelines, GitHub Actions.

## Phase 6: Reporting and Dashboard

- Markdown executive summary.
- Single-file interactive HTML dashboard.
- Dashboard sections: Repository Health, Workflow Risk Map, Behavioral Diff Viewer, Confidence Timeline, Adversarial Probes, Verification Budget.
- UX focus: trust, explainability, actionability.

## Phase 7: Extensibility & Open Source

- Plugin architecture for custom risk/confidence models and enterprise policy engines.
- Community-contributed graph enrichers, verification heuristics, language adapters.
- Workflow classifier rules curated per vertical (fintech, healthcare, IoT, gaming).
