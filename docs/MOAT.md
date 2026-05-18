# Veris — Defensibility Strategy

This document is the honest read on what makes Veris hard to clone and what doesn't. Maintained for contributors and sponsors deciding where to invest.

## What is NOT a moat

- **The workflow classifier.** Rule-based keyword voting. Anyone can fork.
- **Adversarial probe templates.** Static library. Copyable in an afternoon.
- **SHA-256 fingerprinting + drift detection.** Trivial math.
- **Half-life confidence decay.** Standard formula.
- **17 MCP tools.** Surface area, not depth.
- **The behavioral graph.** `ts-morph` does the parsing; anyone can build the same graph.

A weekend project could ship 80% of the above. Pretending otherwise burns trust.

## What IS the moat (ordered by durability)

### 1. Plugin ecosystem ownership

Veris ships a minimal core. The interesting intelligence lives in plugins (vertical rules, runtime risk catalogs, custom risk heuristics, language adapters). Whichever project becomes the default plugin host gets the network effect.

**Investment direction:**
- First-party vertical plugins (fintech, healthcare, IoT, gaming, regtech) maintained in `examples/` and `plugins/community/`.
- Plugin marketplace / index at `plugins.veris.dev` (static site, indexes GitHub-hosted plugins).
- Plugin manifest spec (`veris-plugin.json`) with version + capability declarations.
- Curation: signed plugins, security review badge, popularity rank.

### 2. The standard for "behavioral diff"

ESLint won not because of its rules but because it became *the* place rules live. Veris can be *the* place behavioral verification specs live.

**Investment direction:**
- Publish a "Behavioral Diff Spec" — a vendor-neutral format describing workflow boundaries, runtime risks, and verification tiers.
- Sample reference implementations in Python (Go later) so the spec is not TS-locked.
- Submit to the MCP working group.

### 3. Benchmark dataset + leaderboard

Curate a labeled dataset of real-world repos with ground-truth workflow boundaries and known incident postmortems. Veris score vs other tools = citation gravity.

**Investment direction:**
- "Veris Verification Benchmark" — 50 open-source repos, hand-labeled.
- Public leaderboard at `bench.veris.dev`.
- Reproducible Docker run that anyone can submit a tool to.

### 4. Cross-repo fleet view

Once a team registers 3+ services in `~/.veris/registry.json`, switching cost rises with every new service. Confidence trends across services become the daily-dashboard surface they cannot easily migrate.

**Investment direction:**
- Polish `cross_repo_snapshot` — a confidence-across-fleet view.
- Multi-repo workflow stitching: detect "payments-api" + "payments-worker" as one logical workflow.
- Federated fingerprints: detect drift in a workflow that spans services.

### 5. Confidence calibration data

Veris emits a confidence score. Nobody currently has data on how well that score predicts actual incidents. If Veris publishes a calibration curve (predicted vs observed) using opt-in telemetry from the community, it becomes the citation for "this is what 70/100 confidence actually means in production."

**Investment direction:**
- Opt-in calibration telemetry (off by default, single-flag enable, transparent payload).
- Annual published calibration report.
- Per-workflow-kind calibration tables.

### 6. Adversarial probe corpus

The static probe library today is starter material. The moat is *community-contributed real-world incidents distilled into reusable probes*. Like SANS Top 25 for behavioral verification.

**Investment direction:**
- Probe submission flow with anonymization.
- Probe taxonomy + tags.
- Per-workflow probe library curated by maintainers.

## What we explicitly do NOT do

- No paid tier. No license gating. No phone-home telemetry by default.
- No cloud-hosted runtime. The MCP server is local-only and stays that way.
- No replacing existing tools (test runners, CI, agents). Veris is the intelligence layer; execution stays delegated.

## How "going viral" actually works for Veris

OSS viral != SaaS viral. Drivers in order:

1. **A 30-second demo gif on the README.** Most repos die here.
2. **One concrete killer use case** with screenshots. "Detect silent rewrites in your auth code" beats "behavioral verification infrastructure."
3. **HN / Lobsters launch post** with the calibration data or benchmark numbers.
4. **First five vertical plugins** showcase ecosystem.
5. **Integration with one major MCP client's marketplace** (skills.sh, official MCP registry).
6. **A maintainer who answers issues in <24h.**

Algorithm depth is irrelevant in steps 1–6. Brand + responsiveness + ecosystem velocity wins.

## Anti-moats (things that would hurt)

- Trying to add features faster than the docs/quality can keep up.
- Accepting plugins without security review (one bad plugin = ecosystem-wide trust hit).
- Going closed-core later — instant fork.
- Letting the dashboard become a Christmas tree of charts nobody reads.

Keep it ruthlessly focused on: **what changed, why it matters, what to verify, how confident we are.**
