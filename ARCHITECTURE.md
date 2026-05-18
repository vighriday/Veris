# Behavioral Verification Infrastructure (BVI) Architecture

This document provides a high-level overview of the end-to-end architecture built native to TypeScript/Node.js mapping directly to the 33-section PRD.

## Core Data Flow

The BVI operates as a stateless data pipeline, transforming raw source code ASTs into probabilistically penalized confidence reports.

\`\`\`
[ Raw Source Code ] 
        ↓ (ts-morph / Phase 1)
[ Entity Models ] (Files, Classes, Functions)
        ↓ (Phase 2)
[ Behavioral Graph ] (Nodes, Edges, Dependencies)
        ↓ (Phase 3)
[ Risk Models ] (Blast Radius, Fragility, Diffs)
        ↓ (Phase 4)
[ Verification Plan ] (Structural, Behavioral, Adversarial Tiers)
        ↓ (Phase 5)
[ Confidence Engine ] (Penalized Scores, Unverified Assumptions)
        ↓ (Phase 6 / 7)
[ Reporting & Integrations ] (Markdown, HTML, MCP, CLI, CI/CD)
\`\`\`

## System Components

### 1. Intelligence & Parsing (`src/engine/RepositoryIntelligenceEngine.ts`)
- Deeply inspects repository environments utilizing `ts-morph`.
- Maps classes, functional components, and module relations without needing actual runtime compilation or Docker containerization.

### 2. Behavioral Graph (`src/engine/BehavioralGraphEngine.ts`)
- Maps Abstract Syntax Trees to `NodeType` and `EdgeType` graph boundaries.
- Resolves implicit linkage, such as engine dependencies depending deeply upon underlying model modifications.

### 3. Risk Assessment (`src/engine/RiskModelingEngine.ts` & `BehavioralDiffEngine.ts`)
- Ingests multiple Semantic snapshots.
- Identifies missing, impacted, or fragile node trees.
- Produces explicit english-language explanations mapping precisely why a score was generated (e.g. "High blast radius due to 8 integrations").

### 4. Verification Planning & Confidence (`src/engine/*`)
- Orchestrates Risk vectors into executable targets (`VerificationPlanningEngine.ts`).
- Generates base confidence metrics that degrade mathematically until executions happen (`ConfidenceEngine.ts`).

### 5. Standard Constraints & MCP (`src/mcp/McpServer.ts`)
- Exposes entire engine architecture across the Model Context Protocol.
- Allows autonomous agents (like Claude Code / Cursor) to read graphs and risk metrics directly via JSON over `stdio`.

### 6. Standard Execution Layers
- **Native Dashboards**: HTML / Markdown generations for human reviews.
- **Global `bvi` CLI**: Executable via `npx bvi` binding to `package.json`.
- **GitHub Actions**: Fully integrated `.github/workflows/bvi.yml` CI/CD blocks.

## Extension and Extensibility
- Designed utilizing Standard DTO Objects (`src/models/`). New engines checking novel vulnerabilities or languages simply need to map their targets to these schemas.
