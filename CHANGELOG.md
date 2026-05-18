# Changelog

All notable changes to the Behavioral Verification Infrastructure (BVI) will be documented in this file.

## [Unreleased]

### Added
- **Phase 5: MCP Integration Layer** implemented end-to-end.
  - Implemented `@modelcontextprotocol/sdk` as standard protocol constraint mapping to Claude Code and Cursor standard inputs.
  - Added `McpServer.ts` registering specific actions requested in the PRD (like `export_behavioral_graph` and `analyze_pr_behavior`).
  - Added dedicated `start:mcp` command allowing execution within compatible Autonomous Execution systems over stdio.
- **Phase 4: Verification Planning & Confidence Engine** implemented end-to-end.
  - Implemented `VerificationModels.ts` to type structural, behavioral, and adversarial tiers.
  - Built `VerificationPlanningEngine.ts` to map risk profiles generated in Phase 3 into Verification Plans and execution directives (E.g delegates CI checks vs Adversarial execution).
  - Built `ConfidenceEngine.ts` to calculate `overallConfidence` explicitly grading penalizations based upon untrusted assumptions and partial completion depths (`executionDepth`).
- **Phase 3: Behavioral Diff & Risk Modeling** implemented end-to-end.
  - Implemented `RiskModels.ts` to export typing around Risk Scores, Explanations, and Diffs.
  - Implemented `BehavioralDiffEngine.ts` taking in snapshots of Behavioral Graphs and identifying delta metrics (`addedNodes`, `impactedNodes`).
  - Implemented `RiskModelingEngine.ts` processing Impact reports sequentially, identifying blast radius arrays and attaching transparent, English-readable UX elements back directly into output.
- **Phase 2: Semantic Understanding & Behavioral Graph Engine** implemented.
  - Generates graph nodes (`NodeType.Service`, `NodeType.Method`, `NodeType.Function`).
  - Tracks relationship semantics (`EdgeType.DependsOn`) using dependency paths, successfully verifying inter-file connections (e.g., `BehavioralGraphEngine` depending on `BehavioralGraph`).
- Included Architecture Models stub outlining the Plugin Architecture, Security constraints, and Zero-Retention mapping references.
- **Phase 1: Repository Intelligence Engine** implemented.
  - Basic AST parsing engine (`RepositoryIntelligenceEngine.ts`) parsing Typescript/JS code.
  - Setup core entity models (`BVIFile`, `BVIClass`, `BVIFunction`, `RepositoryIntelligenceReport`).
  - Added project files (`package.json`, `tsconfig.json`) using `ts-morph` dependency for structural mapping.
- `PLAN.md`: Initial phased implementation plan based on the BVI Product Requirements Document.
- `CHANGELOG.md`: Initialized changelog for tracking development phases and features end-to-end.
- Updated `PLAN.md` to map explicitly to all 33 sections of the PRD including Verification Tiers, Security, Explainability, Plugins, and Dashboard details.

- **Phase 6: Reporting & Dashboards** implemented end-to-end.
  - Built \ReportingEngine.ts\ compiling \RiskReport\, \ConfidenceReport\, and \VerificationPlan\ into explicit Executive Summaries.
  - Native markdown generation via BVI standard output directory (\vi-reports/bvi-report.md\).
  - Implemented dynamic static HTML dashboard generation for visual UI verification points.

- **Phase 7: CI/CD Action Binding & CLI hook-ins** implemented end-to-end.
  - Built \src/cli.ts\ enabling terminal execution of the entire BVI pipeline natively over targeted directories.
  - Binded execution node natively within \package.json bin\. 
  - Added \vi.yml\ defining GitHub Actions execution logic running on PRs to standard CI environments preventing merging on failed execution.
