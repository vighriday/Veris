# Veris — Behavioral Verification Infrastructure

Veris is the verification intelligence layer for autonomous software engineering. It does not run your tests. It tells autonomous agents (Claude Code, Cursor, CI pipelines) **what behaviors are at risk, what to verify, and how confident the result actually is** — backed by a behavioral graph, semantic workflow grouping, persistent history, and explainable confidence math.

Fully open source. MCP-native. Local-first. No cloud required.

## Why Veris

Most AI coding tools optimize for code generation; verification stays shallow. Veris fills the gap:

- **Behavioral graph** of your repo — classes, methods, functions linked by `DependsOn` + `Invokes`.
- **Semantic workflow clustering** — auto-groups nodes into domains (Authentication, Billing, Checkout, Caching, Queue, Webhooks, …) so the dashboard speaks the language of behaviors, not files.
- **Real git-worktree diff** vs base ref — not a synthetic placeholder.
- **Risk scoring with explanations** — blast radius, fragility, runtime criticality, in plain English.
- **Confidence math with half-life decay** — verifications get stale. A passing run from 30 days ago is worth less than one from yesterday.
- **Behavioral drift detection** — same members, different internal topology = silent rewrite. Surface expansion, contraction, oscillation, all named.
- **Counterfactual mode** — `what_if_revert(nodeIds)` simulates rollback impact.
- **Adversarial probe generator** — concrete Tier 3 hypotheses (concurrency, idempotency, replay, retry storms, cache stampedes) per high-risk node.
- **Verification budget allocator** — given N minutes, picks the highest-leverage targets.
- **Workflow-first onboarding maps** — exports a markdown package new engineers can actually read.
- **Cross-repo snapshot** — registered services queried in one view.

All of it exposed over MCP. All of it OSS.

## Install

```bash
npm install
npm run build
```

## Run against any repo

```bash
node dist/cli.js .                              # current directory
node dist/cli.js ../my-service --base-ref=origin/main
node dist/cli.js . --budget=10 --onboarding
```

Outputs:

- `veris-reports/veris-report.md` — markdown executive summary
- `veris-reports/veris-dashboard.html` — interactive single-file dashboard (vis-network graph, heatmap, drift, probes, budget, history)
- `veris-reports/onboarding/` — workflow maps (with `--onboarding`)
- `.veris/state.db` — persistent run history

CI gate: `VERIS_CONFIDENCE_THRESHOLD=70` exits with code 2 below threshold.
Zero-retention: `VERIS_STATE_DISABLED=1` skips all writes.

## Scaffold a new project

```bash
node dist/cli.js init
```

Creates `.veris/plugins/`, `config.json`, and a disabled sample plugin.

## MCP

Register Veris as an MCP server for Claude Code / Cursor:

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

17 tools available. See [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) for the full reference and recommended flows.

## Plugins

Drop a `.js` file into `.veris/plugins/`:

```js
module.exports.register = function (api) {
    api.addWorkflowRule({
        kind: 'Payments',
        importTokens: ['stripe', '@yourorg/billing-sdk'],
        weight: 3
    });
    api.addRuntimeRisks('Payments', [
        '3DS challenge response lost on tab close'
    ]);
};
```

See [docs/PLUGINS.md](docs/PLUGINS.md). Example: [examples/plugin-fintech.js](examples/plugin-fintech.js).

## Architecture

```text
Source -> AST (ts-morph)
       -> Behavioral Graph (DependsOn + Invokes)
       -> Real git-worktree diff vs base ref
       -> Risk model (blast / fragility / criticality + explanations)
       -> Workflow classifier (semantic domain grouping)
       -> Fingerprints -> Drift detector (vs SQLite history)
       -> Adversarial probe generator
       -> Verification plan (Tier 1/2/3)
       -> Budget allocator (leverage / cost)
       -> Confidence engine (half-life decay over execution history)
       -> Reports + interactive dashboard
       -> MCP (17 tools) -> autonomous agents close the loop via report_execution
```

See [ARCHITECTURE.md](ARCHITECTURE.md), [PLAN.md](PLAN.md), and the original PRD ([behavioral_verification_infrastructure_prd.md](behavioral_verification_infrastructure_prd.md)).

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Open source, sponsor-funded. No paid tier. Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
