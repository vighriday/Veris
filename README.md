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
[![Veris MCP server](https://glama.ai/mcp/servers/vighriday/Veris/badges/score.svg)](https://glama.ai/mcp/servers/vighriday/Veris)

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
| **Behavioral graph** | Classes, methods, constructors, accessors and functions linked by `DependsOn` (containment, imports) and `Invokes` edges. Call targets are resolved through the TypeScript checker; a call whose target is ambiguous produces **no edge** rather than one per same-named declaration. Every edge declares how it was established |
| **Semantic workflows** | Grouped into 25 domains (Authentication, Billing, Checkout, Caching, Queue, Webhooks, AI, ...) by a weighted keyword vote over paths, imports and symbol names. This is labelling, not call-graph traversal — see [honest limits](#honest-limits) |
| **Real git diff** | Worktree diff against the **merge-base** with your base ref, restricted to git-tracked files. If no baseline resolves, the run fails with a reason — Veris never fabricates one |
| **Risk scoring** | Coupling magnitude, inbound-coupling dominance and runtime criticality, each measuring something the others do not, with plain-English explanations. Weights live in `data/risk-config.json` |
| **Verification coverage** | How much planned work has evidence, weighted by tier, decayed by age, and weighted by how the evidence was obtained. Not a probability that your code is correct |
| **Drift detection** | Workflow fingerprints over repository-relative member ids, internal topology **and normalized body hashes** — so a rewritten body with unchanged names is caught, and a directory rename is not reported as drift |
| **Counterfactual mode** | `what_if_revert(nodeIds)` simulates rollback impact |
| **Adversarial probes** | Concrete Tier 3 hypotheses per workflow kind (idempotency, replay, retry storms, cache stampede) |
| **Budget allocator** | Knapsack on `(tier × criticality × risk) / cost`. Highest-leverage subset within N minutes |
| **Knowledge transfer** | Workflow-first onboarding markdown package |
| **Cross-repo view** | Register multiple services; one MCP call for fleet-wide confidence |
| **Interactive dashboard** | Standalone HTML. Graph view, click workflow → filter everything, ESC to clear, click-to-copy directives |

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

- **Local-first.** All analysis runs on your machine.
- **No telemetry.** Veris does not phone home. Nothing about your code leaves the machine.
- **Zero-retention mode.** `VERIS_STATE_DISABLED=1` skips all `.veris/state.db` writes.
- **No network sockets in the analyzer.** The MCP server and CLI speak stdio and the
  filesystem only. The generated dashboard is a separate artifact opened in a browser —
  check [`src/reporting/ReportingEngine.ts`](src/reporting/ReportingEngine.ts) for any
  asset it references.

---

## Plugins

> **Plugins execute code from the repository being analyzed, so they are OFF by
> default.** Pass `--allow-plugins` (or set `VERIS_ENABLE_PLUGINS=1`) to enable them,
> and only for repositories you trust. Veris prints each plugin's path and SHA-256
> before executing it. There is no sandbox. See [SECURITY.md](SECURITY.md).

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
git-tracked source
   -> AST + checker-resolved call targets (ts-morph)
   -> Behavioral graph (repository-relative ids, body hashes, typed edge resolution)
   -> Worktree snapshot at merge-base   [fails loudly if no baseline exists]
   -> Diff (added / removed / MODIFIED-body / edges)
   -> Risk model (coupling magnitude + inbound dominance + criticality)
   -> Workflow classifier (25 keyword-voted domains, plugin-extensible)
   -> Fingerprints -> drift detector (vs SQLite history)
   -> Adversarial probes + tiered verification plan + budget allocation
   -> Coverage engine (tier-weighted, time-decayed, trust-weighted evidence)
   -> Reports + dashboard
   -> MCP (17 validated, size-capped tools)
        -> agents close the loop via report_execution
        -> evidence is append-only, hash-chained and trust-typed
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deep dive.

---

## Honest limits

> **Upgrading from 2.x?** 3.0 changes behaviour you may depend on — a missing
> baseline is now an error rather than a fabricated diff, plugins no longer execute
> by default, and node ids are repository-relative. See [UPGRADING.md](UPGRADING.md).


What Veris does not do, stated plainly so nobody has to discover it the hard way.

- **A workflow is a label, not a path.** Classification is a weighted keyword vote
  over directory names, import specifiers and symbol names. It does not traverse the
  call graph, so a "workflow" is a set of declarations sharing a label — it has no
  entry point and no ordering. Expect misfiles: rate-limiting code that imports Redis
  lands in Caching; a file under `models/` lands in Persistence.

- **Coverage is not assurance.** `identify_unverified_behaviors` reports how much
  planned verification has evidence behind it, decayed by age and weighted by how the
  evidence was obtained. It has never been calibrated against real incidents, so it
  does not estimate the probability that your code is correct, and it should not be
  cited as though it does. `overallConfidence` is an alias of that coverage figure,
  kept for API compatibility.

- **Risk is a heuristic.** Coupling magnitude, inbound-coupling dominance and a
  name-and-path criticality regex. It is useful for ranking what to look at first. It
  is not a defect predictor and has no ground truth behind it.

- **Probes are a curated library, not generated tests.** The adversarial scenarios
  are real failure modes written by hand and selected by workflow kind. They are not
  derived from your code, so they name the failure mode rather than your call site.

- **TypeScript and JavaScript only.** Python and Go adapters are on the roadmap.
  Multi-language repositories are analyzed for their TS/JS portion only.

- **Some calls cannot be resolved.** Dynamic dispatch, `any`-typed values and untyped
  JavaScript defeat the checker. Those calls produce no edge, and the counts appear in
  `analyze_repository` output. Missing edges understate coupling; they never invent it.

- **A baseline is required.** Veris compares against the merge-base with a real git
  ref. Outside a git repository, or in a shallow clone with no common ancestor, it
  fails with an explanation instead of producing a diff against something imaginary.

Findings from the internal architecture audit, including what has been fixed and what
remains, are tracked in [`docs/internal/BUG_TRACKER.md`](docs/internal/BUG_TRACKER.md).

---

## Roadmap

What is coming next, where help moves the needle: [ROADMAP.md](ROADMAP.md).

Active bugs and fixes land in [CHANGELOG.md](CHANGELOG.md) per patch release.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

OSS, sponsor-supported. No paid tier. No gated features.

## License

MIT. See [LICENSE](LICENSE).
