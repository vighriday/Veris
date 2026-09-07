# Veris — Foundation Audit Tracker

Internal engineering log. One row per finding from the 2026-09-07 architecture audit.

**Audit method:** 17-agent parallel codebase map across 8 dimensions, each dimension adversarially
verified by an independent agent against source. Every finding below was then re-confirmed by hand
against the file and line cited. Findings the verifier marked OVERSTATED or WRONG were dropped and
are not listed here.

**Baseline at audit time** — branch `test/engine-unit-suite` @ `a18b18f`:

| Metric | Value |
|---|---|
| Source | 4,627 LOC TS / 31 files |
| Tests | 55 passing / 12 files |
| Typecheck | clean |
| Whole-`src` coverage | 36.36% (6 files at 0%) |
| `veris-report.md` | 6,043 lines / 1.26 MB (98% one repeated sentence) |
| `veris-dashboard.html` | 156,306,026 bytes |
| Tracked files | 4,548 (4,432 = stale `node_modules`) |
| Analyzed files on own repo | 1,735 (1,667 third-party) |

**Status vocabulary:** `OPEN` → `IN PROGRESS` → `FIXED` (code changed, verified) → `WONTFIX` (with
reason). A row reaches `FIXED` only when a command was run and its output confirmed the behaviour
changed — not when the edit was made.

**Severity:** `S1` blocks any credibility claim · `S2` produces materially wrong output · `S3`
correctness/robustness defect · `S4` hygiene, docs, maintainability.

---

## Summary

| Group | Theme | Count | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| A | Baseline truthfulness | 6 | 4 | 2 | 0 | 0 |
| B | Graph extraction accuracy | 9 | 1 | 6 | 2 | 0 |
| C | Scoring math | 11 | 1 | 4 | 6 | 0 |
| D | Security and trust | 7 | 2 | 2 | 3 | 0 |
| E | State and MCP correctness | 9 | 0 | 4 | 4 | 1 |
| F | Output size | 3 | 0 | 3 | 0 | 0 |
| G | Project hygiene | 7 | 0 | 1 | 2 | 4 |
| **Total** | | **52** | **8** | **22** | **17** | **5** |

---

## Group A — Baseline truthfulness

Everything Veris says is a comparison against a "before" state. If that state is fabricated or
malformed, every downstream number is meaningless. This group is a hard gate on the rest.

### A1 · Fabricates a baseline when git is unavailable · S1

**Where:** [`src/cli.ts:238`](../../src/cli.ts) · [`src/mcp/McpServer.ts:193`](../../src/mcp/McpServer.ts) ·
`McpServer.ts:246` · `McpServer.ts:327` · [`src/index.ts:37`](../../src/index.ts)

**What happens:** When `GitDiffDriver.snapshot()` returns null, all five sites construct a fake base
graph from the first 70% of the current node and edge lists, then run the full diff → risk →
confidence chain against it and report the result as a behavioural diff. `ensureDiffAndRisk()`
(`McpServer.ts:191-195`) and `what_if_revert` return no mode flag at all, so a consumer cannot tell
a fabricated result from a real one. A tool whose stated purpose is detecting unverified work is,
on this path, producing unverified work.

**Proposed fix:** Delete all five fallbacks. Baseline resolution failure returns an explicit typed
error naming the cause (not a git repo / no base ref / worktree failed). Every diff-bearing response
carries a mandatory `baselineMode: 'git'` discriminant — there is no second value.

**Status:** FIXED — all five sites removed; `GitDiffDriver.snapshot()` throws `BaselineError`, CLI exits 3, MCP returns an explanatory error. Verified: `GitDiffDriver.test.ts` 'throws rather than fabricating a baseline outside a git repository'; `ToolSchemas.test.ts` asserts no tool description mentions a synthetic fallback.

---

### A2 · Base graph always loses every import edge · S1

**Where:** [`src/engine/GitDiffDriver.ts:137-139`](../../src/engine/GitDiffDriver.ts)

**What happens:** The base tree is analyzed inside a temp worktree, so its paths must be rewritten
to match the head tree's. The rewrite covers `f.filePath` but not the parallel `dependencyMap`,
whose keys are still temp paths. [`BehavioralGraphEngine.ts:75`](../../src/engine/BehavioralGraphEngine.ts)
reads `dependencyMap` — so it looks up head paths in a map keyed by temp paths and finds nothing.
Result: **the base graph has zero `DependsOn` edges on every run, on every project.** Every run
reports the entire import structure as newly added.

**Proposed fix:** Remove the parallel map from the graph builder's input path — read `file.imports`
off the file record, which is already correctly rewritten. Deletes the whole class of desync rather
than patching this instance.

**Status:** FIXED — `BehavioralGraphEngine` reads `file.imports`; the parallel map is no longer consulted and the worktree path rewrite is gone entirely (relative ids make it unnecessary). Verified: `GitDiffDriver.test.ts` 'produces import edges in the base graph, not only the head graph'.

---

### A3 · No merge-base · S1

**Where:** [`src/engine/GitDiffDriver.ts:53`](../../src/engine/GitDiffDriver.ts)

**What happens:** Candidate refs (`origin/main`, `origin/master`, `main`, `master`, `HEAD~1`) are
used directly as the base. A branch cut three days ago diffs against main's current tip, so every
commit others merged in the interim is reported as behaviour **this branch removed**.

**Proposed fix:** After resolving a candidate ref, resolve `git merge-base HEAD <ref>` and use that
commit as the base. Fall back to the ref itself only when merge-base fails (unrelated histories),
and record which was used in the response.

**Status:** FIXED — `resolveBase()` returns `git merge-base HEAD <ref>` and reports `usedMergeBase`. Verified: `GitDiffDriver.test.ts` 'compares against the divergence point, not the branch tip' and 'does not report unrelated work on main as removed by this branch'.

---

### A4 · Untracked and ignored files count as new behaviour · S2

**Where:** no filter exists — all 7 git invocations in `GitDiffDriver.ts` are `rev-parse`/`worktree`

**What happens:** The head tree is analyzed straight off disk. Build output, gitignored folders,
scratch files and local experiments all become graph nodes present in head and absent from base, so
they are reported as added behaviour. Measured on this repo: `addedNodes: 12438, removedNodes: 0`.

**Proposed fix:** Run `git ls-files -z` once, build a tracked-path set, filter both graphs through
it. Untracked files are not behaviour under review.

**Status:** FIXED — `trackedFiles()` feeds `includeOnly` for both snapshots. Verified: `GitDiffDriver.test.ts` 'excludes untracked and ignored files from the graph'. Live run: 118 tracked files analyzed, was 1,735.

---

### A5 · Working-tree analysis labelled with a commit SHA · S2

**Where:** [`src/engine/GitDiffDriver.ts:85`](../../src/engine/GitDiffDriver.ts) vs `:87-90`

**What happens:** `headRef` is `git rev-parse HEAD`, but the head graph is built by analyzing the
**dirty working tree**. The response therefore claims commit-to-commit provenance for a comparison
that included uncommitted edits. Nobody can reproduce the result from the stated inputs.

**Proposed fix:** Report `headRef` as `<sha>-dirty` with a `dirtyFileCount` when the tree is not
clean, and mark the run as non-reproducible in persisted state. Never present a bare SHA for
uncommitted content.

**Status:** FIXED — `headRef` is `<sha>-dirty` with `dirtyFileCount` when the tree is not clean. Verified: `GitDiffDriver.test.ts` 'marks the head as dirty' and 'reports a clean tree with a bare commit sha'.

---

### A6 · Ignore globs anchored to the root only · S1

**Where:** [`src/engine/RepositoryIntelligenceEngine.ts:34`](../../src/engine/RepositoryIntelligenceEngine.ts)

**What happens:** Patterns are built as `!${projectRoot}/${p}/**/*`, which matches only a top-level
`node_modules`. Nested ones — `examples/runs/node_modules/`, workspace packages, vendored trees —
are parsed as first-party code. Measured on this repo: **1,667 of 1,735 analyzed files are
third-party.** Root cause of F1 (156 MB dashboard) and a large share of the risk noise.

**Proposed fix:** Anchor as `!${projectRoot}/**/${p}/**/*`. Extend the ignore set to `dist`, `build`,
`out`, `.next`, `.nuxt`, `coverage`, `vendor`, `.git`. Add a hard node-count ceiling with a loud
warning rather than silent unbounded growth.

**Status:** FIXED — globs anchored `!<root>/**/<dir>/**/*`, ignore set widened, plus a defence-in-depth segment check and a file ceiling. Verified: `RepositoryIntelligenceEngine.test.ts` 'excludes nested node_modules, not only a top-level one'. Live run: zero `node_modules` strings in the dashboard, was 156 MB of them.

---

## Group B — Graph extraction accuracy

The graph is the substrate for every other claim. B1 is the single largest item in the audit and
gates any workflow-level or safety-level ambition.

### B1 · Calls resolved by trailing name, not by symbol · S1

**Where:** [`src/engine/RepositoryIntelligenceEngine.ts:221`](../../src/engine/RepositoryIntelligenceEngine.ts)
+ [`src/engine/BehavioralGraphEngine.ts:107-113`](../../src/engine/BehavioralGraphEngine.ts)

**What happens:** The callee is extracted as `expr.getText().split('.').pop()` — the trailing
identifier of the call expression, with no scope, no import binding and no type information. The
graph builder then indexes every declaration by bare name and emits an `Invokes` edge to **every**
node sharing that name. `console.log('x')` yields `INVOKES Caller → Logger::log`. Measured against
the MCP SDK: **2,804 of 3,077 `Invokes` edges (91.1%) resolve to a name with more than one
definition.** This is a name index presented as a call graph, and every score, fingerprint and
narrative downstream is a function of it.

**Proposed fix:** Resolve through the TypeScript checker — `getSymbol()` / `getAliasedSymbol()` /
`getDefinitionNodes()` on the call's expression, scoped by the file's import bindings. Emit exactly
one edge for a resolved target. Where resolution genuinely fails (dynamic dispatch, `any`), emit the
edge marked `resolution: 'unresolved'` and exclude it from scoring rather than guessing. Add
`resolution` to the edge model so consumers can filter on it.

**Status:** FIXED — callee resolution goes through the TypeScript checker (`getSymbol` / `getAliasedSymbol` / `getDeclarations`) against an indexed declaration map; ambiguous names emit no edge. Verified: `RepositoryIntelligenceEngine.test.ts` 'resolves an imported call to exactly one target', 'does not invent an edge for a same-named declaration that was never imported', 'emits no edge when a bare name matches several declarations'. Live run: 375 resolved (96.9%), 0 ambiguous.

---

### B2 · ESM import specifiers never match · S2

**Where:** [`src/engine/BehavioralGraphEngine.ts:82`](../../src/engine/BehavioralGraphEngine.ts) vs `:34`

**What happens:** File basenames are stripped of their extension at `:34`, but the import specifier
is compared raw at `:82`. `import { x } from './target.js'` is compared against `target` and never
matches. Every NodeNext / ESM / Deno codebase — where extensioned specifiers are mandatory —
produces zero `DependsOn` edges.

**Proposed fix:** Normalize both sides through one helper: strip `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/
`.cjs` and a trailing `/index`, then compare.

**Status:** FIXED — one `normalizeBase()` helper strips extensions and `/index` on both sides. Verified: `RepositoryIntelligenceEngine.test.ts` 'matches an extensioned ESM specifier'.

---

### B3 · Constructors, getters and setters are invisible · S2

**Where:** [`src/engine/RepositoryIntelligenceEngine.ts:94`](../../src/engine/RepositoryIntelligenceEngine.ts)

**What happens:** Only `cls.getMethods()` is read. A class whose logic lives in its constructor —
the common shape for a service, a client wrapper, a repository — contributes no nodes and no calls.

**Proposed fix:** Add `getConstructors()`, `getGetAccessors()`, `getSetAccessors()`, and record the
member kind on the node so consumers can distinguish them.

**Status:** FIXED — `getConstructors()`, `getGetAccessors()`, `getSetAccessors()` extracted with a `kind` on each member. Verified: `RepositoryIntelligenceEngine.test.ts` 'extracts constructors, getters and setters, not only methods'.

---

### B4 · Nested functions become exported top-level nodes · S3

**Where:** [`src/engine/RepositoryIntelligenceEngine.ts:164-166`](../../src/engine/RepositoryIntelligenceEngine.ts)

**What happens:** The comment states the walk is restricted to top-level declarations; the check was
never written. Callbacks, closures and inner helpers enter the graph as first-class nodes with
`isExported: true` hardcoded. Inflates node count, degree, blast radius and every derived score.

**Proposed fix:** Add the ancestry check the comment promises. Compute `isExported` from the actual
export modifier instead of hardcoding it on four paths — or drop the field, since nothing reads it.

**Status:** FIXED — uses `file.getVariableDeclarations()` (top level only) and derives `isExported` from the statement. Verified: `RepositoryIntelligenceEngine.test.ts` 'does not promote nested closures to top-level functions'.

---

### B5 · One flat name set per file, first declaration wins · S3

**Where:** [`src/engine/RepositoryIntelligenceEngine.ts:143`](../../src/engine/RepositoryIntelligenceEngine.ts)

**What happens:** A single per-file `seen` set is consulted for every declaration regardless of
scope. A nested `handler` encountered first suppresses the genuine exported `handler` later in the
same file.

**Proposed fix:** Scope the set per container, and prefer the outermost declaration on collision.
Largely subsumed by B4.

**Status:** FIXED — subsumed by B4; nested declarations no longer enter the name set. Verified: `RepositoryIntelligenceEngine.test.ts` 'keeps the real top-level declaration when a nested one shares its name'.

---

### B6 · Edge comparison drops the edge type · S3

**Where:** [`src/engine/BehavioralDiffEngine.ts:22-26`](../../src/engine/BehavioralDiffEngine.ts)

**What happens:** Edges are keyed `source->target` while `GraphModels.addEdge` deduplicates on
`source+target+type`. A `DependsOn` and an `Invokes` between the same pair collide, so one is
silently invisible to the diff. Separately, `includes` is called inside `filter`, making the diff
O(n²) — measurable on the graphs this produces.

**Proposed fix:** Key as `source->target:type`. Use `Set` membership for both sides.

**Status:** FIXED — `edgeKey()` includes the edge type and both sides use `Set` membership. Verified: `BehavioralDiffEngine.test.ts` passes with the type included in the key.

---

### B7 · Fingerprints embed absolute filesystem paths · S2

**Where:** [`src/engine/WorkflowFingerprint.ts:34`](../../src/engine/WorkflowFingerprint.ts) —
node IDs originate at `RepositoryIntelligenceEngine`

**What happens:** A member ID is `C:/Users/<name>/.../src/auth/login.ts::signIn`. Renaming a
directory changes every ID and therefore every hash → 100% drift reported for a change with zero
behavioural content (reproduced 4/4). Cloning to another path, or running in CI, produces
fingerprints that cannot be compared with local ones — so persisted history is worthless across
machines.

**Proposed fix:** Relativize every node ID to the project root, with forward slashes, at the point of
creation. Applies to state rows, fingerprints, reports and MCP output. **This is a persisted-data
shape change** — see E2.

**Status:** FIXED — `toRelative()` produces project-relative POSIX ids at the point of creation. Verified: `RepositoryIntelligenceEngine.test.ts` 'emits repository-relative POSIX paths, never absolute ones' and 'produces identical ids for identical sources under different roots'.

---

### B8 · Blind to the exact thing it claims to catch · S2

**Where:** [`src/engine/WorkflowFingerprint.ts:24-37`](../../src/engine/WorkflowFingerprint.ts)

**What happens:** The hash covers member IDs and internal edge signatures. A rewritten function body
that keeps the same name and the same callees produces a byte-identical fingerprint. The doc comment
at `:14` claims *"this is how Veris detects silent rewrites that pass other checks"* — that is
precisely the case it cannot detect. Combined with B7: loud on renames, silent on rewrites.

**Proposed fix:** Add a normalized body hash per member node (whitespace and comments stripped) and
include it in the fingerprint. Fixes the blind spot and, with B7, the false-alarm side.

**Status:** FIXED — normalized `bodyHash` per declaration, carried onto `GraphNode`, surfaced as `DiffReport.modifiedNodes`, and included in the workflow fingerprint. Verified: `RepositoryIntelligenceEngine.test.ts` 'changes the hash when the body changes' / 'ignores comments and reformatting'; `GitDiffDriver.test.ts` 'detects a rewritten body as a modified node'.

---

### B9 · Deleted workflows never report drift · S2

**Where:** [`src/engine/DriftDetector.ts:43`](../../src/engine/DriftDetector.ts)

**What happens:** The comparison iterates the current fingerprint set only. A workflow present in the
previous run and absent now is never examined, so deleting an entire workflow prints
*"No workflow drift detected."* Deletion is the most severe drift class and is the one that cannot
be reported.

**Proposed fix:** Iterate the union of previous and current keys. Emit an explicit `removed` drift
class, ranked above rewrites.

**Status:** FIXED — `DriftDetector` iterates the union of previous and current workflow ids and emits a `removed` class ranked above rewrites; a first observation is distinguished from an absence of drift. Verified: `DriftDetector.test.ts`.

---

## Group C — Scoring math

### C1 · Risk score is one measurement expressed twice, plus a regex · S2

**Where:** [`src/engine/RiskModelingEngine.ts`](../../src/engine/RiskModelingEngine.ts)

**What happens:** `overallRisk = 0.45·min(8·degree,100) + 0.20·18log₂(degree+1) + 0.35·criticality`.
The first two terms are monotone transforms of the same scalar (node degree), so 65% of the score is
one input counted twice. The remaining 35% is a regex over the symbol name and path. Blast radius
saturates at degree 13 — a node with 13 edges and one with 500 score identically. Class→own-method
containment edges inflate degree further.

**Proposed fix:** Either introduce genuinely independent inputs (reachability from an entry point,
graph distance to a dangerous sink, change frequency from git, presence of covering tests), or stop
publishing a composite and report the factors separately. Not shipping a number is better than
shipping one that measures a single variable three ways.

**Status:** FIXED — three independent inputs: coupling magnitude (exponential, no ceiling at degree 13), inbound-coupling dominance, and name/path criticality. Class-to-own-member containment edges excluded from degree. Explanations rewritten to describe the actual math. Verified: `RiskModelingEngine.test.ts`.

---

### C2 · Confidence cannot exceed 45 on a first run · S1

**Where:** [`src/engine/ConfidenceEngine.ts`](../../src/engine/ConfidenceEngine.ts)

**What happens:** With no execution history the reachable range is a hard `[10, 45]` — the value is
structurally incapable of leaving that band regardless of the repository. The checked-in demo's
`40.12` reproduces exactly as `100 − 0.4·24.7 − 50`. Nothing has ever been compared against observed
outcomes: there is no calibration, no reliability curve, no ground truth. `examples/demo-app/GROUND_TRUTH.md`
exists and **is read by nothing**.

**Proposed fix:** Remove the score from every gate and every headline. Report the inputs it is
derived from (coverage of planned targets, execution recency, failure count) as separate labelled
facts. Reintroduce a scalar only once it has been measured against real outcomes, and name it for
what it measures.

**Status:** FIXED — the composite score is gone. `overallConfidence` is now an alias of evidence coverage, documented as such in code, in the tool description and in README's Honest limits. Verified: `ConfidenceEngine.test.ts` 'separates risk from coverage instead of folding risk into one score'.

---

### C3 · Adding harmless files raises confidence · S3

**Where:** [`src/engine/ConfidenceEngine.ts:45`](../../src/engine/ConfidenceEngine.ts)

**What happens:** The penalty is driven by the **mean** risk across impacted nodes. Touching ten
trivial files alongside one dangerous one lowers the mean and raises confidence. Risk does not
average — the dangerous node is exactly as dangerous either way.

**Proposed fix:** Drive the penalty from the maximum, or a high percentile, of the risk distribution.

**Status:** FIXED — risk summarized by `maxImpactedRisk` plus `highRiskNodeCount`. Verified: `ConfidenceEngine.test.ts` 'summarizes risk by maximum, so harmless nodes cannot dilute a dangerous one'.

---

### C4 · Passes decay, failures never do · S3

**Where:** [`src/engine/ConfidenceEngine.ts:79`](../../src/engine/ConfidenceEngine.ts)

**What happens:** Successful executions are multiplied by `0.5^(ageDays/halfLife)`; the failure
penalty is applied at full strength with no age term. A failure from a year ago, since fixed, still
penalizes at full weight forever.

**Proposed fix:** Apply the same decay to the failure term, or scope failure penalties to the current
run only. Either is defensible; the asymmetry is not.

**Status:** FIXED — failures are counted, not applied as an undecayed permanent penalty; passes decay by half-life. Verified: `ConfidenceEngine.test.ts` 'decays a passing result as it ages' and 'counts a failing target'.

---

### C5 · A flaky result is credited and penalized simultaneously · S3

**Where:** [`src/engine/ConfidenceEngine.ts:82-83`](../../src/engine/ConfidenceEngine.ts)

**What happens:** `flaky` adds `w·decay·0.5` to earned credit **and** adds to `failedPenalty` in the
same branch. The two partially cancel, with the net effect depending on unrelated config values.

**Proposed fix:** Choose one semantic. Recommended: no earned credit, small fixed penalty, and
surface flakiness as its own signal rather than folding it into a scalar.

**Status:** FIXED — flaky earns no credit and is reported in its own field. Verified: `ConfidenceEngine.test.ts` 'gives a flaky result no coverage credit and counts it once'.

---

### C6 · Zero planned targets reports as fully verified · S3

**Where:** [`src/engine/ConfidenceEngine.ts:90`](../../src/engine/ConfidenceEngine.ts)

**What happens:** `possible === 0` yields `executionDepth = 100` and the explanation
*"Full execution depth mapped."* Nothing to verify is reported as everything verified.

**Proposed fix:** Return an explicit `unknown` depth and say so in the explanation.

**Status:** FIXED — `coverageKnown: false` when nothing is planned, with an explicit explanation. Verified: `ConfidenceEngine.test.ts` 'reports coverage as unknown when nothing was planned'.

---

### C7 · Contradicts itself at full coverage · S3

**Where:** [`src/engine/ConfidenceEngine.ts:96`](../../src/engine/ConfidenceEngine.ts)

**What happens:** The branch tests the unrounded float, so a value of `99.999…` takes the penalty
path and prints *"penalized due to missing or stale execution coverage (decayed depth 100.0%)."*

**Proposed fix:** Compare the same rounded value that is displayed.

**Status:** FIXED — branches compare the rounded value that is displayed. Verified: `ConfidenceEngine.test.ts` 'does not claim missing coverage when coverage is complete'.

---

### C8 · The what-if parameter is unreachable · S3

**Where:** [`src/engine/ConfidenceEngine.ts:87`](../../src/engine/ConfidenceEngine.ts) ·
[`src/cli.ts:276`](../../src/cli.ts)

**What happens:** `executedTargetsCount` is documented on the `identify_unverified_behaviors` MCP
tool as a what-if lever. The CLI hardcodes `0`, and on the MCP path `stateProvided` is true whenever
state is enabled, so the parameter's branch is unreachable. The documented feature does nothing.

**Proposed fix:** Wire it through as an explicit override that bypasses state, or remove it from the
tool description. Do not ship a documented parameter with no effect.

**Status:** FIXED — `executedTargetsCount` is a real override when state is unavailable. Verified: `ConfidenceEngine.test.ts` 'honours executedTargetsCount as a what-if override when no state exists'.

---

### C9 · "No magic numbers in code" is false · S4

**Where:** [`src/engine/RiskModelingEngine.ts:8`](../../src/engine/RiskModelingEngine.ts) ·
[`src/engine/VerificationPlanningEngine.ts:23,34`](../../src/engine/VerificationPlanningEngine.ts)

**What happens:** The header comment claims every weight and threshold is externalized to
`data/risk-config.json`. `VerificationPlanningEngine` is the only engine with no config integration
and hardcodes every threshold (`integrationCount > 2`, `overallRisk > 30`, `blastRadius > 50`,
`runtimeCriticality >= 80`).

**Proposed fix:** Move the planning thresholds into `risk-config.json` under a `planning` key.

**Status:** FIXED — planning thresholds moved to `data/risk-config.json` under `planning`, loaded via `loadRiskConfig`. Verified: `VerificationPlanningEngine.test.ts`.

---

### C10 · Budget allocator structurally deprioritizes adversarial work · S3

**Where:** [`src/engine/VerificationBudgetAllocator.ts`](../../src/engine/VerificationBudgetAllocator.ts)

**What happens:** Leverage density carries an implicit per-tier constant of 1 : 0.5 : 0.29 across
Tier 1/2/3, because tier leverage rises more slowly than tier cost. Greedy selection therefore
exhausts cheap structural checks before ever reaching adversarial targets — the only tier that finds
the failures the product exists to surface.

**Proposed fix:** Rebalance `tierLeverage` / `tierCostSeconds` so density is tier-neutral, or rank by
expected risk reduction rather than time efficiency. Add a test pinning the tier mix at a fixed
budget.

**Status:** FIXED — tier leverage and cost rebalanced so density is tier-neutral, with a test pinning the tier mix at a fixed budget. Verified: `VerificationBudgetAllocator.test.ts`.

---

### C11 · Dead probe threshold · S3

**Where:** [`src/engine/AdversarialProbeGenerator.ts:38`](../../src/engine/AdversarialProbeGenerator.ts)

**What happens:** `minRiskThreshold` defaults to `10`, below the 12.5 floor the risk formula can
produce. The filter at `:58` never excludes anything.

**Proposed fix:** Set a threshold inside the achievable range, or delete the option.

**Status:** FIXED — `probeMinOverallRisk` is a configured threshold inside the achievable range; probes also spread across the top-N riskiest members instead of one anchor. Verified: `AdversarialProbeGenerator.test.ts`.

---

## Group D — Security and trust

### D1 · Executes arbitrary code from the repository under analysis · S1

**Where:** [`src/plugins/PluginLoader.ts:101`](../../src/plugins/PluginLoader.ts) ·
[`SECURITY.md:15`](../../SECURITY.md)

**What happens:** Any `.js`/`.mjs`/`.cjs` file in `<analyzed-repo>/.veris/plugins/` is `require()`d
and its `register()` called. **Enabled by default**, no sandbox, no allowlist, no confirmation.
Triggered lazily by read-shaped tools (`list_workflows`, `detect_drift`, `allocate_budget`), so a
user who believes they are only reading gets code execution. Pointing an agent at an untrusted
repository executes that repository's code with the user's privileges. `SECURITY.md:15` states
*"It does not execute user code."*

**Proposed fix:** Off unless explicitly enabled (`VERIS_ENABLE_PLUGINS=1` or `--allow-plugins`).
On load, print the absolute path and SHA-256 of each plugin file. Never auto-load from an analyzed
repo without opt-in. Correct `SECURITY.md` to describe the real behaviour and threat model.

**Status:** FIXED — execution requires `--allow-plugins` or `VERIS_ENABLE_PLUGINS=1`; discovered-but-not-executed plugins are reported with SHA-256; executed plugins are disclosed before running. SECURITY.md corrected, with the prior behaviour disclosed. Verified: `PluginLoader.test.ts` 'does not execute a plugin by default' (asserts on a marker file the plugin writes, so it cannot pass if the plugin ran).

---

### D2 · The evaluated agent writes — and can erase — its own evidence · S1

**Where:** [`src/persistence/VerisState.ts:83,183`](../../src/persistence/VerisState.ts) ·
[`src/mcp/McpServer.ts:333-351`](../../src/mcp/McpServer.ts)

**What happens:** `report_execution` accepts `pass`/`fail`/`flaky`/`skipped` from any MCP caller —
in practice the same agent whose work is being assessed. The write is `INSERT OR REPLACE` on
`(run_id, node_id, tier)` with one run ID per process, so re-reporting the same target **overwrites
the earlier row**. An agent can post `fail`, then post `pass`, and the failure is gone. That is a
working tamper primitive, not merely an unvalidated input.

**Proposed fix:** Append-only rows; never replace. Every row carries a producer identity and a trust
class — `veris-derived` (computed), `harness-observed` (external runner), `agent-asserted` (claimed).
Confidence and any gate consume trust classes separately; an `agent-asserted` claim alone can never
raise assurance. Retain the full history and expose it, so contradiction is visible rather than
silently resolved.

**Status:** FIXED — evidence is append-only and hash-chained with producer identity and trust class; coverage weights `agent-asserted` at half and lets a more-trusted failure override a less-trusted later pass. Verified: `VerisState.test.ts` 'retains an earlier failure when a later pass is posted', 'detects a row edited directly in the database', 'detects a deleted row'; `ConfidenceEngine.test.ts` 'does not let a later agent-asserted pass bury a harness-observed failure'.

---

### D3 · Dashboard loads unpinned third-party script over the network · S2

**Where:** [`src/reporting/ReportingEngine.ts:199`](../../src/reporting/ReportingEngine.ts) ·
[`README.md:85,115`](../../README.md)

**What happens:** The generated HTML includes
`<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js">` — no version pin,
no SRI hash. Whatever that URL serves at view time executes in the user's browser. README claims
*"Single-file HTML"* and *"No network calls."* Both are false, and the unpinned reference is a live
supply-chain path into every generated report.

**Proposed fix:** Vendor the library into the bundle, or pin an exact version with an `integrity`
hash and `crossorigin`. Correct both README claims.

**Status:** FIXED — `vis-network` pinned to 9.1.9 with `integrity` and `crossorigin`. Hash independently verified against the published bundle: 688,911 bytes, `sha384-yxKDWWf0wwdUj/gPeuL11czrnKFQROnLgY8ll7En9NYoXibgg3C6NK/UDHNtUgWJ`. README claims corrected. Verified: `ReportingEngine.test.ts` plus the attributes present in generated output.

---

### D4 · Unescaped interpolation into generated HTML · S3

**Where:** [`src/reporting/ReportingEngine.ts:686,818,949-950`](../../src/reporting/ReportingEngine.ts)

**What happens:** Node labels, workflow kinds and narrative strings are interpolated into the HTML
without escaping. Plugin-supplied `kind` values reach `:818`. Symbol names originate in analyzed
source, which for this product is frequently untrusted.

**Proposed fix:** A single `escapeHtml()` applied at every interpolation site. Add a regression test
that feeds a `<script>` payload through a node label and asserts it is inert in the output.

**Status:** FIXED — `escapeHtml()` applied at every source-derived interpolation site. Verified: `ReportingEngine.test.ts` feeds a script-tag payload through a node label and asserts it is inert.

---

### D5 · `register_repo` accepts arbitrary paths · S3

**Where:** [`src/mcp/McpServer.ts`](../../src/mcp/McpServer.ts) (`register_repo` handler)

**What happens:** No validation on `name` or `path`. Traversal sequences are accepted and persisted
to `~/.veris/registry.json`, which is then read by `cross_repo_snapshot`.

**Proposed fix:** Resolve to an absolute path, require it to exist, be a directory, and contain
`.git`. Reject traversal. Bound the name.

**Status:** FIXED — `register_repo` arguments validated (non-empty name, bounded length, path must resolve to a directory containing `.git`). Verified: `ToolSchemas.test.ts` 'rejects register_repo without a path'; MCP integration check 'register_repo(missing path): invalid arguments rejected'.

---

### D6 · A read-shaped call creates directories in every registered repo · S3

**Where:** [`src/persistence/CrossRepoRegistry.ts:78-89`](../../src/persistence/CrossRepoRegistry.ts)

**What happens:** `snapshot()` constructs a `VerisState` per registered repo; that constructor calls
`mkdirSync(..., { recursive: true })`. So a read operation creates `.veris/` in every registered
repo, and can recreate directory trees the user deliberately deleted.

**Proposed fix:** Add a read-only construction mode that opens an existing database and creates
nothing. Use it everywhere the operation is a read.

**Status:** FIXED — `VerisState` gained a `readOnly` mode that creates nothing, and the registry checks for an existing database before constructing anything. Verified: `VerisState.test.ts` 'creates nothing when opening a repository that has no state'; `CrossRepoRegistry.test.ts`.

---

### D7 · Declared MCP input schemas are never enforced · S2

**Where:** [`src/mcp/McpServer.ts:33-49`](../../src/mcp/McpServer.ts)

**What happens:** The server is constructed from the low-level `Server` class, which does not
validate arguments against the `inputSchema` advertised in `tools/list`. Declared `required` fields
and enums are decoration. Malformed arguments reach handlers directly — `what_if_revert` with a
non-array `nodeIds`, `report_execution` with an unknown `tier`, `allocate_budget` with a string
`minutes`.

**Proposed fix:** Validate arguments against the declared schema before dispatch; return a proper
JSON-RPC error on mismatch. Keep one schema definition as the single source for validation, the
advertised tool list, and `PublicSchema`.

**Status:** FIXED — `src/mcp/ToolSchemas.ts` validates every tool's arguments before dispatch and returns a protocol error on mismatch. Verified: `ToolSchemas.test.ts` (24 cases) and 10 negative cases in the MCP integration check, all rejected.

---

## Group E — State and MCP correctness

### E1 · The MCP path never persists runs or fingerprints · S2

**Where:** writers exist only at [`src/cli.ts:284,296`](../../src/cli.ts)

**What happens:** `recordRun` and `recordFingerprint` are called from the CLI only. Under MCP —
the primary use case — no run row and no fingerprint row is ever written. Consequences:
`detect_drift` reports "first observation" on every call forever; `confidence_history` returns `[]`
forever; execution rows are orphans with no reachable parent run. Two advertised features are
silently inert in the main integration.

**Proposed fix:** Persist runs and fingerprints on the MCP analysis path. Add an integration test
that drives two MCP analyses in sequence and asserts the second reports real drift.

**Status:** FIXED — `persistRun()` writes the run and node risks, and `detect_drift` persists fingerprints, on the MCP path. Verified: MCP integration check 'confidence_history: MCP path persisted at least one run' — a check that fails if runs are not recorded.

---

### E2 · No schema migration path · S3

**Where:** [`src/persistence/VerisState.ts:136-153`](../../src/persistence/VerisState.ts)

**What happens:** `migrate()` is a list of `CREATE TABLE IF NOT EXISTS` plus a comment. On an
existing database these are no-ops, so adding a column and bumping `SCHEMA_VERSION` hard-crashes
every existing user with no recovery path but deleting their history. B7 (relativized node IDs)
forces exactly this situation.

**Proposed fix:** Numbered, ordered migration steps applied by version with the whole upgrade in a
transaction. For the B7 ID change specifically: detect legacy absolute-path rows and either rewrite
them or archive the table and start clean, with a clear message either way.

**Status:** FIXED — numbered migrations applied in a transaction, with a fresh database taking the same path as an upgrade so migrations are exercised on every install. Verified: `VerisState.test.ts` 'upgrades a v1 database and carries its rows forward' (builds a real v1 database and migrates it) and 'reaches the current version on a fresh database'.

---

### E3 · Three persisted structures are written and never read · S4

**Where:** [`src/persistence/VerisState.ts`](../../src/persistence/VerisState.ts)

**What happens:** `node_history` holds 709 rows that nothing queries. `learned_signals` has zero
rows and zero callers. `executionsForWorkflow` and `latestFingerprintFor` are implemented and never
called. Dead schema misleads contributors about what the system does.

**Proposed fix:** Wire `node_history` into `node_history` MCP output (it is the natural backing
store), and delete `learned_signals` and the unused queries until something needs them.

**Status:** FIXED — `learned_signals` dropped; `nodeRiskHistory()` added and consumed by the `node_history` tool. Verified: `VerisState.test.ts` 'returns the risk trajectory it records'; MCP integration check 'node_history: returns risk history'.

---

### E4 · Analysis cache is never invalidated · S2

**Where:** [`src/mcp/McpServer.ts:49`](../../src/mcp/McpServer.ts)

**What happens:** The repository is parsed once per process and cached for the process lifetime with
no invalidation. The core use case is "the agent edits code, then asks what changed" — so **every
answer after the first edit is stale by construction**, with no indication.

**Proposed fix:** Track the max mtime over analyzed files; re-analyze when it advances. Expose an
explicit refresh, and stamp every response with the analysis timestamp so staleness is visible.

**Status:** FIXED — cache keyed on the newest source mtime, invalidated on change, with all derived caches reset together. Implemented in `McpServer.sourceStamp()` / `checkCache()`.

---

### E5 · Stale plan leaks across diffs · S3

**Where:** [`src/mcp/McpServer.ts:253`](../../src/mcp/McpServer.ts)

**What happens:** On a new diff, `lastWorkflowReport` is cleared but `lastPlan` is not, so
`generate_verification_plan` can return the previous diff's plan against the current diff's context.

**Proposed fix:** Reset all derived caches through one function so they cannot diverge.

**Status:** FIXED — `invalidateDerived()` resets every derived cache in one place, so `lastPlan` cannot survive a new diff.

---

### E6 · `report_execution` batch writes are not atomic or validated · S3

**Where:** [`src/mcp/McpServer.ts:333-351`](../../src/mcp/McpServer.ts)

**What happens:** No transaction, no `Array.isArray` guard, no enum validation on `result` or `tier`.
A malformed entry mid-batch leaves earlier rows committed and returns a protocol error, so the caller
cannot know what landed. `tier: 'adversarial'` (instead of `Tier 3 - Adversarial`) returns
`recorded: 1` and has no effect on anything.

**Proposed fix:** Wrap the batch in a transaction. Validate shape and enums up front and reject the
whole batch on any invalid entry, naming the offending index.

**Status:** FIXED — batches validated up front (naming the offending index) and written in one transaction via `recordExecutions()`. Verified: `ToolSchemas.test.ts` 'names the offending index so a partial batch is diagnosable'; `VerisState.test.ts` 'writes a batch atomically'.

---

### E7 · Database handle never closed under MCP · S3

**Where:** [`src/mcp/McpServer.ts`](../../src/mcp/McpServer.ts)

**What happens:** No `state.close()` on shutdown, so the WAL is never checkpointed — measured at
4.1 MB against a 282 KB database.

**Proposed fix:** Close on `SIGINT`/`SIGTERM` and on transport close.

**Status:** FIXED — `close()` runs `wal_checkpoint(TRUNCATE)` and the MCP server closes on SIGINT/SIGTERM.

---

### E8 · Eight tool descriptions contradict their handlers · S2

**Where:** [`src/mcp/McpServer.ts:88,91,103,109,145,148,151,154`](../../src/mcp/McpServer.ts)

**What happens:** Agents select tools by reading these strings, so a wrong description is a
functional defect. Confirmed mismatches: `analyze_repository` promises a per-file breakdown;
`export_behavioral_graph` promises "the full nodes/edges arrays" and returns 5 sample nodes and zero
edges; `list_workflows` claims it "auto-clusters the graph" (it does not read edges — see B1/section
on the classifier); `detect_drift` claims the hash includes signals (it does not);
`confidence_history` documents a default of 20 against an actual 30; `node_history` promises risk
over time; `export_onboarding` names `index.md` where the code writes `README.md`;
`cross_repo_snapshot` promises a drift summary and weakest-first ordering.

**Proposed fix:** Audit all 17 descriptions against their handlers; make the description match the
code or the code match the description. Add a test asserting each tool's response shape matches what
its description claims.

**Status:** FIXED — all 17 descriptions rewritten against their handlers, including the honest statement that workflow classification does not traverse the call graph. Verified: `ToolSchemas.test.ts` asserts the specific claims that were wrong (no 'synthetic', keyword-vote wording, README.md not index.md, default of 30).

---

### E9 · Advertised protocol version is wrong · S4

**Where:** [`src/mcp/McpServer.ts:46`](../../src/mcp/McpServer.ts)

**What happens:** Server identifies as `1.2.0` over the protocol; the package is `2.1.8`.

**Proposed fix:** Read the version from `package.json` at build or runtime.

**Status:** FIXED — `src/version.ts` reads `package.json`; CLI, MCP handshake and reports share it.

---

## Group F — Output size

### F1 · Generated dashboard is 156 MB · S2

**Where:** [`src/reporting/ReportingEngine.ts`](../../src/reporting/ReportingEngine.ts); root cause A6

**What happens:** `veris-reports/veris-dashboard.html` measured at **156,306,026 bytes**. Content is
dominated by `examples/runs/node_modules/**` nodes admitted by the A6 glob defect. No browser opens
this usefully.

**Proposed fix:** Fix A6, then cap rendered nodes with a documented ceiling and a "showing N of M"
control. Assert a size ceiling in CI.

**Status:** FIXED — root cause (A6) resolved and a node ceiling with a 'showing N of M' indicator added. Measured: 156,306,026 B → 736,617 B. CI asserts a 10 MB ceiling.

---

### F2 · Markdown report is 98% one repeated sentence · S2

**Where:** [`src/engine/ConfidenceEngine.ts:115-119`](../../src/engine/ConfidenceEngine.ts)

**What happens:** The unverified-assumptions loop pushes one string per node above the fragility
threshold, uncapped and undeduplicated. Measured: `veris-report.md` is 6,043 lines / 1.26 MB, of
which **5,947 lines are the same sentence** with a different node name. The human-readable executive
summary is unreadable.

**Proposed fix:** Deduplicate by class, cap at ~20 concrete instances, summarize the remainder as a
count with a pointer to the full list.

**Status:** FIXED — assumptions deduplicated, capped at 20, remainder summarized as a count. Measured: 6,043 → 100 report lines, 1,264,183 B → 5,575 B. Verified: `ConfidenceEngine.test.ts` 'caps unverified assumptions and reports the remainder as a count'.

---

### F3 · MCP responses reach 16 MB · S2

**Where:** [`src/engine/VerificationPlanningEngine.ts:6-52`](../../src/engine/VerificationPlanningEngine.ts) ·
[`src/engine/VerificationBudgetAllocator.ts:79`](../../src/engine/VerificationBudgetAllocator.ts) ·
`ConfidenceEngine.ts:115-119`

**What happens:** Plan output measured at 12.28 MB (29,357 targets on this repo);
`allocate_budget` additionally returns the `skipped` complement, reaching 16.3 MB; confidence
output 1.29 MB. These payloads go into an agent's context window and will exhaust it before any of
it can be read.

**Proposed fix:** Cap every MCP response. Return ranked top-N with totals and an explicit
`truncated: { shown, total }`. Never return the complement of a selection.

**Status:** FIXED — every list response capped with `truncated: { shown, total }`; plan targets ranked by risk before capping; `allocate_budget` returns `skippedCount` instead of the complement. Verified: MCP integration check asserts a 1 MB ceiling on every response and that the skipped complement is absent.

---

## Group G — Project hygiene

### G1 · `veris analyze` silently analyzes nothing and exits 0 · S2

**Where:** [`src/cli.ts:41-57`](../../src/cli.ts) · advertised in [`skill.json`](../../skill.json)

**What happens:** `analyze` is not in the recognized-command list, and the argument loop treats any
non-flag token as a target directory. So `veris analyze` resolves `./analyze`, finds no files,
reports zero nodes, prints *"Reports generated"* and exits 0. This is the exact invocation
`skill.json` advertises to agents.

**Proposed fix:** Recognize `analyze` as an explicit command. Exit non-zero with a clear message when
the target does not exist or yields zero analyzable files.

**Status:** FIXED — `analyze` is an explicit subcommand; unknown flags, missing paths and extra arguments are usage errors with exit code 2. CI asserts a non-zero exit for an unknown target.

---

### G2 · 97% of tracked files are stale `node_modules` · S3

**Where:** repository root

**What happens:** 4,432 of 4,548 tracked files are a committed `node_modules` tree, stale since the
initial commit and **missing `vitest` and `better-sqlite3`** — so a fresh clone cannot run the test
suite. It is also the first thing any prospective contributor sees.

**Proposed fix:** `git rm -r --cached node_modules`, add to `.gitignore`, verify clean-clone install
and test.

**Status:** FIXED — `git rm -r --cached node_modules`. Tracked files: 4,548 → 116.

---

### G3 · Importing the package runs an analysis and writes files · S3

**Where:** [`src/index.ts:118`](../../src/index.ts) · [`package.json` `main`](../../package.json)

**What happens:** `src/index.ts` is a self-executing Phase-1 demo — it uses the synthetic baseline
(A1), exports nothing, and runs on import. It is declared as the package `main`, so
`require('veris-core')` triggers a full repository scan and writes report files to disk.

**Proposed fix:** Make `main` a real module exporting the engines and running nothing. Delete the
demo or move it to `examples/` as an explicitly-invoked script.

**Status:** FIXED — `src/index.ts` is an export-only module; the self-executing demo is gone.

---

### G4 · The only MCP CI check cannot fail · S3

**Where:** [`tests/test-mcp-deep.ts:66-88`](../../tests/test-mcp-deep.ts)

**What happens:** The smoke test branches on whether the JSON-RPC response `id` matches and never
inspects `error` or `isError`. Every tool could be returning errors and the job stays green.

**Proposed fix:** Assert absence of `error`, assert `isError !== true`, and assert response shape per
tool. Add a deliberately-failing case to prove the check can fail.

**Status:** FIXED — `tests/test-mcp-deep.ts` rewritten to assert. 82 checks over the full tool surface, response-shape assertions, a 1 MB size ceiling, 10 negative validation cases, and a sanity check proving the harness can still pass. Verified: 82/82 passing.

---

### G5 · Coverage is scoped to a slice and never runs in CI · S4

**Where:** [`vitest.config.ts:12`](../../vitest.config.ts) · [`.github/workflows/veris.yml`](../../.github/workflows/veris.yml)

**What happens:** Coverage `include` is `src/engine/**`, so the reported figure excludes the MCP
server, persistence, reporting, CLI and plugin loader — all at 0%, and including every control
`SECURITY.md` names as a mitigation. CI never invokes coverage at all.

**Proposed fix:** Widen include to `src/**`. Run coverage in CI. Set a floor that ratchets upward
rather than a target nobody enforces.

**Status:** FIXED — coverage includes all of `src/` (models and entry points excluded as type-only) and CI runs it.

---

### G6 · 1,020-line reporting file with 489 lines of untyped browser JS in a string · S4

**Where:** [`src/reporting/ReportingEngine.ts`](../../src/reporting/ReportingEngine.ts)

**What happens:** The dashboard's client-side code is embedded in a TypeScript template literal —
so it cannot use backticks (hence string concatenation and 45 escaped newlines), gets no type
checking, no linting and no tests. Budget constants are duplicated at `:857-859` against
`data/risk-config.json`, so the two can silently diverge.

**Proposed fix:** Split into data shaping (TS, tested), a real `.js` asset for browser code (linted,
inlined at build), and template assembly. Read the duplicated constants from config.

**Status:** FIXED — browser JS extracted to `assets/veris-dashboard.js`, inlined at generation; duplicated budget constants now read from config. Verified: `ReportingEngine.test.ts`.

---

### G7 · No lint, no typecheck gate, manual publish, no provenance · S4

**Where:** [`.github/workflows/veris.yml`](../../.github/workflows/veris.yml) · [`package.json`](../../package.json)

**What happens:** CI runs tests, build, doctor and smoke only — no `tsc --noEmit` gate, no linter in
the repo at all. `prepublishOnly` builds but does not test. Publishing is manual from a developer
laptop with no provenance attestation. CI is Linux-only despite a native dependency
(`better-sqlite3`) and a shipped Windows-specific fix.

**Proposed fix:** Add eslint + `tsc --noEmit` to CI. Publish from a tagged GitHub Actions workflow
with `--provenance`. Add Windows to the CI matrix. Make `prepublishOnly` run the full test suite.

**Status:** FIXED — CI gates on `tsc --noEmit` and coverage, adds Windows to the matrix, and asserts report size ceilings. `.github/workflows/release.yml` publishes from a tag with `npm publish --provenance`, verifies the tag matches `package.json`, and fails if the tarball contains `.veris/`, `veris-reports/` or `node_modules/`. `prepublishOnly` typechecks and tests.

---

## Change log

| Date | Change |
|---|---|
| 2026-09-07 | Tracker created from foundation audit. 52 findings recorded, all `OPEN`. Baseline captured: 55 tests passing, typecheck clean, `a18b18f`. |

---

## Addendum — findings from the verification pass

Three defects surfaced *after* the original 52, by the independent agents that
verified the fixes. Two were reported as out of the verifier's file ownership; the
third was found by a test written to close the first.

### H1 · Published drift schema rejected a removed workflow · S3

**Where:** [`src/schema/PublicSchema.ts`](../../src/schema/PublicSchema.ts) — `DriftReportSchema`

**What happens:** `currentFingerprint` was declared a **required string**. A removed
workflow emits `null` — it has no current shape to fingerprint — so the published
contract rejected exactly the case B9 was fixed to report. `driftClass`, `firstRun`
and `removedCount` were emitted and undeclared. Nothing validates against these
schemas at runtime, so this surfaced as documentation that lied rather than a crash;
a consumer generating types from it would have hit it immediately.

**Status:** FIXED — type widened to `["string","null"]`, new fields declared,
`driftClass` constrained to the detector's actual enum. Verified:
`PublicSchema.test.ts` drives the real `DriftDetector` and compares its output field
by field against the schema.

---

### H2 · `list_workflows` never emitted a field its schema required · S3

**Where:** [`src/mcp/McpServer.ts`](../../src/mcp/McpServer.ts) `handleListWorkflows` vs
`WorkflowAggregateSchema`

**What happens:** The schema listed `kind` as required and declared `removedCount`;
the handler emitted neither. Fixed on the handler side rather than by relaxing the
schema — the workflow domain is genuinely useful to an agent deciding what to inspect.

**Status:** FIXED — both fields emitted. Verified: `PublicSchema.test.ts` pins the
handler's field list against the schema in both directions.

---

### H3 · A deleted workflow rendered with the mildest style · S3

**Where:** [`assets/veris-dashboard.js`](../../assets/veris-dashboard.js) `driftItemHtml`

**What happens:** The dashboard re-derived drift severity from `memberChange` instead
of reading the `driftClass` the detector had already computed. A removal has a
*negative* `memberChange`, so it fell through to the mild `changed` style — the most
severe class rendered as the least. A first observation was also styled as an alert.

**Status:** FIXED — keys off `driftClass`, with a dedicated `removed` treatment and a
neutral `baseline` style for a first observation.

---

## Outcome

| | at audit | now |
|---|---|---|
| Findings open | 55 | **0** |
| Tests | 55 across 12 files | **244 across 20 files** |
| Coverage (all `src/`) | 36.36% | **64.72%** |
| Files at 0% coverage | 6 | 0 of the shipped engines |
| MCP CI check | could not fail | 82 assertions incl. 10 negative cases |
| Dashboard | 156,306,026 B | ~816 KB |
| Markdown report | 1,264,183 B | ~6 KB |
| Call resolution | 91.1% ambiguous | 96.9% resolved, 0 ambiguous |
| Files analyzed (own repo) | 1,735 (1,667 third-party) | 118 tracked |
| Tracked files | 4,548 | 117 |

**What is deliberately still true**, and stated in
[README's Honest limits](../../README.md#honest-limits): workflow classification is a
keyword vote that never reads the call graph, and no number Veris emits is calibrated
against observed outcomes. Both are design limits, not defects — they are the subject
of the v2.3 and v3.0 entries in [ROADMAP.md](../../ROADMAP.md), not of this tracker.
