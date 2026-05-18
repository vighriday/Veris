# Veris Roadmap

Living document. Reflects intent, not commitments. PRs welcome on any item.

## Now (v2.1.x — Public Launch)

- [x] MCP-native server with 17 tools over stdio.
- [x] Workflow classifier with 25 default domain rules, fully data-driven via `data/workflow-rules.json`.
- [x] Risk modeling with explainable scoring (blast radius, fragility, runtime criticality, all weights externalized in `data/risk-config.json`).
- [x] Workflow fingerprinting + drift detection (silent rewrites, oscillation).
- [x] Counterfactual mode (`what_if_revert`).
- [x] Adversarial probe templates per workflow kind, externalized in `data/probes.json`.
- [x] Verification budget allocator (greedy knapsack on leverage / cost).
- [x] Confidence engine with half-life decay over real execution history.
- [x] Interactive single-file HTML dashboard (graph, heatmap, drift, probes, budget, history).
- [x] Workflow-first onboarding markdown export.
- [x] Plugin loader (`.veris/plugins/*.js`) for custom rules and risks.
- [x] Cross-repo registry for fleet snapshots.
- [x] Local SQLite state with WAL, zero-retention mode.
- [x] Public npm: `npx veris-core`.

## Next (v2.2 — Coverage and Accuracy)

- [ ] Plugin marketplace index (static site at `plugins.veris.dev`).
- [ ] Plugin manifest spec (`veris-plugin.json`) with capability declarations.
- [ ] Workflow detection: optional ML-assisted classifier trained on labeled OSS repos (opt-in).
- [ ] Smarter fan-in/fan-out path detection for routing workflows.
- [ ] Configurable risk thresholds per workflow kind (e.g. Payments demands 90+).
- [ ] CSV / SARIF export for CI pipelines.
- [ ] PR comment integration via GitHub App.

## Soon (v2.3 — Language Reach)

- [ ] Python language adapter (via tree-sitter or ast module).
- [ ] Go language adapter.
- [ ] Framework adapters: Express, Fastify, NestJS, Next.js routes, Django, FastAPI, Rails.
- [ ] Multi-language monorepo support (workflows spanning TS frontend + Python backend).

## Later (v3.0 — Standard and Calibration)

- [ ] "Behavioral Diff Spec" — vendor-neutral format describing workflow boundaries, runtime risks, verification tiers.
- [ ] Reference implementation in Python.
- [ ] Submit to MCP working group.
- [ ] Annual Confidence Calibration report from opt-in community telemetry.
- [ ] Veris Verification Benchmark — 50 hand-labeled open-source repos with leaderboard.
- [ ] Federated fingerprints: detect drift across services in one logical workflow.

## Known Issues / Active Fixes

See [GitHub issues](https://github.com/vighriday/Veris/issues) for the live list. Issues fixed mid-version land in the next patch release; the CHANGELOG is the canonical log.

## Contribute

Areas where outside help moves the needle most, in priority order:

1. **Vertical plugins** (`examples/plugin-*.js`) for fintech, healthcare, IoT, gaming, regtech.
2. **Language adapters** for Python and Go (Phase 2.3).
3. **Workflow rule tuning** for popular OSS repos — open a PR with classifier output snapshots and proposed rule deltas.
4. **Probe templates** drawn from real production incidents (anonymized).
5. **Calibration data**: report incidents Veris flagged that actually broke, and incidents Veris missed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor guide. See [docs/MOAT.md](docs/MOAT.md) for the strategic context behind these priorities.
