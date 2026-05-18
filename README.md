<p align="center">
  <img src="assets/logo.png" alt="Veris" width="160" />
</p>

<h1 align="center">Veris</h1>

<p align="center"><strong>Behavioral Verification Infrastructure for autonomous coding agents.</strong></p>

[![CI](https://github.com/vighriday/Veris/actions/workflows/veris.yml/badge.svg)](https://github.com/vighriday/Veris/actions/workflows/veris.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#install)
[![MCP](https://img.shields.io/badge/MCP-17_tools-purple)](docs/MCP_TOOLS.md)
[![Local-first](https://img.shields.io/badge/local--first-yes-success)](#privacy)

Veris is the verification intelligence layer that sits between AI coding agents and production reliability. It does **not** run your tests. It tells any MCP-compatible coding agent or CI pipeline **what behaviors are at risk, what to verify, and how confident the result actually is** — backed by a behavioral graph, semantic workflow grouping, persistent run history, drift detection, and explainable confidence math.

**Today: TypeScript + JavaScript repos. Python and Go adapters on the [roadmap](ROADMAP.md).**

Works with any MCP client. CLI works standalone. Fully open source. Local-first. No cloud. No telemetry. No paid tier.

---

## Plug-and-play install

### Option A — As an MCP server (one config line)

Veris speaks the Model Context Protocol. Drop this into any MCP-compatible client config:

```json
{
  "mcpServers": {
    "veris": {
      "command": "npx",
      "args": ["-y", "veris-core", "mcp"]
    }
  }
}
```

Restart the client. 17 tools light up: `analyze_pr_behavior`, `list_workflows`, `detect_drift`, `generate_adversarial_probes`, `allocate_budget`, `what_if_revert`, `report_execution`, and more.

### Option B — As a CLI

```bash
npx veris-core .                                 # analyze current repo
npx veris-core . --base-ref=origin/main          # explicit git base ref
npx veris-core . --budget=10 --onboarding        # 10-min verification plan + onboarding map
npx veris-core init                              # scaffold .veris/ with plugin slot
npx veris-core doctor                            # health check
```

Reports land in `veris-reports/`:

- `veris-dashboard.html` — interactive single-file dashboard (graph, heatmap, drift, probes, budget, history)
- `veris-report.md` — markdown executive summary
- `onboarding/` — workflow-first markdown package for new engineers (with `--onboarding`)

### Option C — From source

```bash
git clone https://github.com/vighriday/Veris
cd Veris
npm install && npm run build
node dist/cli.js .
```

---

## What it gives you

| Surface | What lands |
|---|---|
| **Behavioral graph** | Classes, methods, functions linked by `DependsOn` and real `Invokes` edges (call-expression resolution) |
| **Semantic workflows** | Auto-clustered into 25 domains (Authentication, Billing, Checkout, Caching, Queue, Webhooks, AI, ...) |
| **Real git diff** | Worktree-based diff vs any base ref. Not a placeholder |
| **Risk scoring** | Blast radius, fragility, runtime criticality + plain-English explanations |
| **Confidence math** | Half-life decay over real execution history. Failed runs reduce confidence; flaky = half credit |
| **Drift detection** | SHA-256 workflow fingerprints. Silent rewrites caught (same members, different topology) |
| **Counterfactual mode** | `what_if_revert(nodeIds)` simulates rollback impact |
| **Adversarial probes** | Concrete Tier 3 hypotheses per workflow kind (idempotency, replay, retry storms, cache stampede) |
| **Budget allocator** | Knapsack on `(tier × criticality × risk) / cost`. Highest-leverage subset within N minutes |
| **Knowledge transfer** | Workflow-first onboarding markdown package |
| **Cross-repo view** | Register multiple services; one MCP call for fleet-wide confidence |
| **Interactive dashboard** | Single-file HTML. Vis-network graph. Click workflow → filter everything. ESC to clear. Click-to-copy directives |

---

## Example agent prompts

Any MCP-compatible agent can drive Veris with prompts like these:

```text
veris: analyze_pr_behavior with baseRef=origin/main
veris: list_workflows then detect_drift
veris: generate_adversarial_probes for the highest-risk workflow, then allocate_budget minutes=15
veris: what_if_revert nodeIds=[...]
```

After your agent runs the verifications it executed externally, close the loop:

```text
veris: report_execution executions=[{nodeId:..., tier:'Tier 3', result:'pass'}, ...]
```

Confidence math now reflects what actually ran.

---

## Privacy

- **Local-first.** Everything runs on your machine.
- **No telemetry.** Veris does not phone home.
- **Zero-retention mode.** `VERIS_STATE_DISABLED=1` skips all `.veris/state.db` writes.
- **No network calls.** The MCP server speaks only over stdio.

---

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

Full plugin API: [docs/PLUGINS.md](docs/PLUGINS.md). Example: [examples/plugin-fintech.js](examples/plugin-fintech.js).

---

## MCP tool reference

17 tools across categories: ingest, diff, plan, semantic, drift, counterfactual, verification, feedback, history, fleet.

See [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) for the full reference with recommended flows.

---

## Architecture

```text
Source -> AST (ts-morph)
       -> Behavioral Graph (DependsOn + Invokes)
       -> Real git-worktree diff vs base ref
       -> Risk model (blast / fragility / criticality + explanations)
       -> Workflow classifier (28 semantic kinds, plugin-extensible)
       -> Fingerprints -> Drift detector (vs SQLite history)
       -> Adversarial probe generator
       -> Verification plan (Tier 1/2/3)
       -> Budget allocator (leverage / cost)
       -> Confidence engine (half-life decay over execution history)
       -> Reports + interactive dashboard
       -> MCP (17 tools) -> autonomous agents close the loop via report_execution
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deep dive.

---

## Roadmap

What is coming next, where help moves the needle: [ROADMAP.md](ROADMAP.md).

Active bugs and fixes land in [CHANGELOG.md](CHANGELOG.md) per patch release.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

OSS, sponsor-supported. No paid tier. No gated features.

## License

MIT. See [LICENSE](LICENSE).
