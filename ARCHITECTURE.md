# Veris Architecture

End-to-end design. TypeScript/Node throughout.

## Core data flow

Veris transforms source into evidence about behavioural change. It executes nothing:
external systems run the verifications and post results back.

```text
[ git-tracked source ]
        |  ts-morph + TypeScript checker              (src/engine/RepositoryIntelligenceEngine.ts)
        v
[ Entity model ]  files, classes, members, functions,
                  resolved call targets, body hashes  (src/models/EntityModels.ts)
        |                                             (src/engine/BehavioralGraphEngine.ts)
        v
[ Behavioral graph ]  nodes + typed, resolution-labelled edges
        |
        |  worktree snapshot at merge-base            (src/engine/GitDiffDriver.ts)
        v
[ Base graph ] vs [ Head graph ]
        |                                             (src/engine/BehavioralDiffEngine.ts)
        v
[ Diff ]  added / removed / modified-body / edges
        |                                             (src/engine/RiskModelingEngine.ts)
        v
[ Risk ]  coupling magnitude, inbound dominance, criticality
        |                                             (src/engine/WorkflowClassifier.ts)
        v
[ Workflows ]  25 keyword-voted domains
        |                                             (Fingerprint / DriftDetector)
        v
[ Fingerprints + drift ]  vs SQLite history
        |                                             (Planning / Probes / Budget)
        v
[ Verification plan + probes + budget allocation ]
        |                                             (src/engine/ConfidenceEngine.ts)
        v
[ Coverage ]  tier-weighted, time-decayed, trust-weighted
        |
        v
[ Reports, dashboard, MCP tools ]  ->  external executors  ->  report_execution
                                                              (append-only evidence)
```

## Invariants

Four properties the design is built to hold. Each replaced a defect found in the
2026-09 architecture audit; the reasoning is preserved here so it is not undone by
accident.

### 1. Never fabricate a baseline

Every claim Veris makes is a comparison against a prior state. If that state cannot
be established, the run **fails with a reason** — it does not synthesize one.

`GitDiffDriver.snapshot()` throws `BaselineError` rather than returning null, so a
caller cannot proceed past a missing baseline by ignoring a return value. The CLI
exits 3; the MCP layer returns an error explaining how to supply a ref.

The baseline is `git merge-base HEAD <ref>`, not the ref's tip: diffing against the
tip attributes other people's merged work to your branch as removals.

### 2. Identity is portable and behavioural

A node id is `relative/path.ts::Symbol` or `relative/path.ts::Class::member` —
repository-relative and POSIX-separated, never absolute.

This has three consequences that all matter:

- Fingerprints survive directory renames and are comparable across machines and CI,
  so persisted history means something.
- The base snapshot needs **no path rewriting**: the same file analyzed under a
  temporary worktree root yields the same id. The class of desync that silently
  emptied the base graph's import edges cannot recur.
- Each node also carries a normalized `bodyHash` (comments and whitespace removed),
  so a rewritten body with unchanged names and callees registers as a `modifiedNode`.

### 3. An edge means something specific

`Invokes` edges come from the TypeScript checker resolving the call expression, not
from matching the trailing identifier against a global name index. Every edge carries
`resolution`:

| value | meaning |
|---|---|
| `resolved` | the checker identified the declaration |
| `heuristic` | the checker could not, and exactly one declaration bears that name |
| `structural` | containment or an import relationship |

A call whose name matches several declarations yields **no edge at all**, and is
counted in `AnalysisStats.callsAmbiguous`. Consumers that must not reason on guesses
filter to `resolved`.

### 4. Evidence is append-only and attributed

Execution results arrive from whoever is verifying — often the agent being assessed.
So `VerisState` stores them append-only and hash-chained, each row carrying a producer
identity and a trust class (`veris-derived`, `harness-observed`, `agent-asserted`).
A later pass never replaces an earlier failure, and `verifyEvidenceChain()` detects
edits made directly to the database file.

The coverage engine weights `agent-asserted` evidence below independently observed
evidence, and treats a more-trusted failure as authoritative over a less-trusted
later pass.

## Components

| Area | File | Responsibility |
|---|---|---|
| Ingest | `engine/RepositoryIntelligenceEngine.ts` | ts-morph parse, checker-backed call resolution, body hashing, ignore/include filtering |
| Graph | `engine/BehavioralGraphEngine.ts` | Nodes and typed edges from the entity model |
| Baseline | `engine/GitDiffDriver.ts` | merge-base resolution, detached worktree, tracked-file filter, dirty detection |
| Diff | `engine/BehavioralDiffEngine.ts` | Added / removed / modified-body nodes, typed edge diff |
| Risk | `engine/RiskModelingEngine.ts` | Coupling magnitude, inbound dominance, criticality; weights from `data/risk-config.json` |
| Semantics | `engine/WorkflowClassifier.ts` | Keyword-vote domain labelling, plugin-extensible |
| Drift | `engine/WorkflowFingerprint.ts`, `engine/DriftDetector.ts` | Deterministic fingerprints; added/removed/rewritten/oscillating detection |
| Planning | `engine/VerificationPlanningEngine.ts` | Tier 1/2/3 targets; thresholds from config |
| Probes | `engine/AdversarialProbeGenerator.ts` | Curated per-domain failure scenarios with invariants |
| Budget | `engine/VerificationBudgetAllocator.ts` | Greedy selection under a time budget |
| Coverage | `engine/ConfidenceEngine.ts` | Tier-weighted, decayed, trust-weighted evidence coverage |
| State | `persistence/VerisState.ts` | Runs, hash-chained evidence, fingerprints, node risk history; versioned migrations |
| Reporting | `reporting/ReportingEngine.ts` | Markdown summary and standalone dashboard |
| MCP | `mcp/McpServer.ts`, `mcp/ToolSchemas.ts` | 17 tools; argument validation, response caps, mtime-based cache invalidation |
| Plugins | `plugins/PluginLoader.ts` | Opt-in execution of repository-supplied rules, disclosed by hash |

## Boundaries

Veris **guides**; it does not execute. It owns no browsers, VMs, sandboxes, CI
infrastructure or runtime. Claude Code, Cursor, GitHub Actions and Playwright execute;
Veris says what is at risk, what to verify, and what evidence exists.

Output size is a hard constraint, not a nicety: every MCP response lands in an agent's
context window, so each list-shaped response is capped and reports
`truncated: { shown, total }` when it elides anything. CI asserts ceilings on the
generated report and dashboard.

## Extending

- **Data**: `data/*.json` ships defaults; `<repo>/.veris/data/*.json` overrides them,
  deep-merged, with `extend: true` to append rather than replace rule arrays.
- **Plugins**: `<repo>/.veris/plugins/*.js` add workflow rules and runtime risks.
  Execution requires `--allow-plugins` — see [SECURITY.md](SECURITY.md).
- **Languages**: `LanguageAdapter` in `models/ArchitectureModels.ts` is the contract
  for non-TS/JS ecosystems. No adapter ships yet; Python and Go are on the roadmap.

## Known limits

Stated in [README's Honest limits](README.md#honest-limits) and tracked in
[`docs/internal/BUG_TRACKER.md`](docs/internal/BUG_TRACKER.md). The two that most
shape the architecture:

- **Workflow classification does not read the graph.** It votes on names and paths,
  so a workflow is a labelled set of declarations, not an execution path with an entry
  point. Moving to entry-point discovery plus call-graph traversal is the largest open
  design question in the project.
- **No number here is calibrated.** Risk and coverage are useful for ranking and for
  knowing what has evidence behind it. Neither predicts real-world failure, and
  neither should be presented as assurance.
