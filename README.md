# Behavioral Verification Infrastructure (BVI)

BVI is a locally executing, stateless data pipeline that transforms raw source code Abstract Syntax Trees (ASTs) into probabilistically penalized confidence reports. It maps Semantic Code Graphs, assesses blast radius risks, and creates intelligent Verification Plans recursively. 

It is designed to give engineering teams (and Autonomous Sub-Agents) absolute mathematical predictability around *why* a particular codebase branch is risky and exactly *what* needs to be executed to secure it, directly complying with Zero-Retention security rules.

## Core Features

- **Phase 1: Repository Intelligence Engine**: Deeply parses TypeScript/JS repositories securely without needing compilation or structural frameworks natively using the `ts-morph` AST.
- **Phase 2: Semantic Behavioral Graph Engine**: Resolves classes, methods, and functions into interconnected Graph Nodes to find exact implicit bindings across files.
- **Phase 3: Behavioral Diff & Risk Modeling**: Diff-checks semantic graphs and scores architectural Blast Radiuses natively calculating Dependency Fragility.
- **Phase 4 & 5: Verification Planning & Confidence Engine**: Mathematically extrapolates confidence scores by applying penalties based on the amount of unexecuted verification limits. 
- **Phase 6: Native Reporting**: Statically generates Markdown (`bvi-report.md`) and HTML Dashboard UI artifacts inside `bvi-reports/`.
- **Phase 7: MCP Integration & CI Pipeline**: Exposes the entire engine standardically on Model Context Protocol over `stdio` allowing agents like Claude Code to trigger scans, alongside native standard GitHub Action blocking (`bvi.yml`).

## Quick Start

### Installation

\`\`\`bash
npm install
npm run build
\`\`\`

### Local Execution (CLI)

Run BVI against the current repository:
\`\`\`bash
npx ts-node src/cli.ts ./
\`\`\`

Run BVI against a specific target repository:
\`\`\`bash
npx ts-node src/cli.ts ../my-other-project
\`\`\`
*(Execution output will be saved sequentially into the `target-dir/bvi-reports/` path natively).*

### MCP Agent Usage

BVI operates as a stateless native Context Protocol Server over stdio. Hook it to your compatible agents (Cursor, Claude Code) locally:
\`\`\`json
{
  "mcpServers": {
    "bvi-core": {
      "command": "node",
      "args": ["/absolute/path/to/Veris/dist/mcp-index.js"]
    }
  }
}
\`\`\`

## Architecture & Data Flow

The architecture operates strictly end-to-end dynamically extracting execution schemas:
\`Raw Source Code -> AST Entities -> Behavioral Graph -> Risk Models -> Verification Plan -> Confidence Score -> Reporting (Markdown/HTML/MCP)\`

See `ARCHITECTURE.md` and the 33-point `behavioral_verification_infrastructure_prd.md` for deep specification structures.

## CI/CD Pipeline

BVI includes a native bound GitHub Action (`.github/workflows/bvi.yml`). When opening PRs, it natively triggers tests preventing risky code from merging if confidence limits trigger unverified thresholds.
