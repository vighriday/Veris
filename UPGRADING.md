# Upgrading to Veris 3.0

3.0 is the result of a full architecture audit: 55 confirmed defects, all fixed and
recorded with evidence in [`docs/internal/BUG_TRACKER.md`](docs/internal/BUG_TRACKER.md).

Several of them changed behaviour you may be depending on. This document is the
complete list, why each changed, and what to do.

**You will not be upgraded automatically.** `^2.x` resolves below `3.0.0`, so npm
will not pull this release for you. That is deliberate — the changes below are real,
and a caret range should not walk anyone into them silently.

---

## Read this first if you are on 2.x

Two behaviours in every 2.x release are worth acting on regardless of when you plan
to upgrade.

### Analysis outside a git repository produced a fabricated baseline

When git was unavailable or no base ref resolved, 2.x built a "before" state from the
first 70% of the current graph and reported the comparison as a real behavioural
diff, with no field distinguishing it from a genuine one.

**If you ran Veris outside a git repository, or in a shallow CI checkout, the diff
you got was invented.** Any risk score, confidence figure, drift finding or
verification plan derived from such a run should be discarded rather than
re-interpreted.

3.0 fails with an explanation instead.

### Plugins executed automatically

2.x `require()`d `<repo>/.veris/plugins/*.js` — code shipped **inside the repository
being analyzed** — by default, with no sandbox. The load was reachable from
read-shaped operations (`list_workflows`, `detect_drift`, `allocate_budget`), so a
user who believed they were only reading got code execution.

**If you pointed 2.x at a repository you do not control, treat that as having
executed its code** with your privileges.

3.0 requires an explicit opt-in and prints each plugin's path and SHA-256 before
running it. See [SECURITY.md](SECURITY.md).

---

## Breaking changes

### 1. A missing baseline is now an error

**Was:** silently substituted a synthetic 70% slice and reported it as a diff.
**Now:** fails — CLI exit code `3`, MCP returns an error explaining how to supply a ref.

Veris compares against `git merge-base HEAD <ref>`. If that cannot be resolved there
is no honest answer to give.

**What to do.** In CI, fetch full history — a shallow clone has no merge-base:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0        # required, not merely recommended
```

Locally, pass a ref explicitly when the default candidates do not apply:

```bash
veris . --base-ref=HEAD~1
veris . --base-ref=origin/develop
```

`veris doctor` now reports baseline resolvability, so you can check before a run.

### 2. Plugins are off by default

**Was:** executed automatically; `VERIS_PLUGINS_DISABLED=1` opted out.
**Now:** not executed; `--allow-plugins` or `VERIS_ENABLE_PLUGINS=1` opts in.

`VERIS_PLUGINS_DISABLED` is gone. If it is set anywhere, it now does nothing — which
is safe, but remove it so nobody assumes it is still protecting them.

```bash
veris . --allow-plugins                  # explicit, per run
VERIS_ENABLE_PLUGINS=1 veris .           # or for the process
```

Only enable this for repositories you trust as much as your own. There is no sandbox.

### 3. Node ids are repository-relative

**Was:** `C:/Users/you/project/src/auth/login.ts::signIn`
**Now:** `src/auth/login.ts::signIn`

Absolute paths meant a directory rename churned every fingerprint, and results from
two machines could never be compared.

**What to do.** Anything storing or matching node ids — dashboards, scripts, saved
`report_execution` payloads — needs updating. Ids are POSIX-separated on every
platform.

Your `.veris/state.db` migrates automatically to schema v2 on first run. History
recorded under absolute ids stays in the database but will not match new ids, so
drift and coverage effectively restart from this release. Nothing is deleted.

### 4. `overallConfidence` means something different

**Was:** a composite score folding risk and execution counts together. With no
execution history its reachable range was a hard `[10, 45]` regardless of the
repository, and it had never been calibrated against real outcomes.

**Now:** an alias of `executionDepth` — tier-weighted, time-decayed, trust-weighted
evidence coverage. It measures how much of the planned verification has evidence
behind it. It does **not** estimate the probability that your code is correct.

**What to do.** If you gate CI on `VERIS_CONFIDENCE_THRESHOLD`, re-baseline it: the
number now moves with your evidence, not with your risk profile. A fresh repository
with no recorded executions reports `0`, not a mid-range figure.

New fields carry what the old score conflated:

```jsonc
{
  "executionDepth": 42.5,     // evidence coverage
  "coverageKnown": true,      // false when nothing was planned — unknown, not 100%
  "plannedTargets": 160,
  "failingTargets": 2,
  "flakyTargets": 1,
  "maxImpactedRisk": 86.9,    // risk, reported separately
  "highRiskNodeCount": 7
}
```

### 5. Execution evidence is append-only and trust-typed

**Was:** `INSERT OR REPLACE` keyed on `(run_id, node_id, tier)`. Re-reporting a target
overwrote the previous row, so a `fail` could be erased by a later `pass`.
**Now:** append-only and hash-chained. Both records persist.

`report_execution` accepts two new optional fields:

```jsonc
{
  "nodeId": "src/pay.ts::charge",
  "tier": "Tier 3 - Adversarial Verification",
  "result": "pass",
  "trustClass": "harness-observed",   // default: "agent-asserted"
  "producer": "github-actions:e2e"    // default: "mcp-client"
}
```

`agent-asserted` evidence — an agent reporting on its own work — counts at half
weight, and a more-trusted failure wins over a less-trusted later pass.

**What to do.** If your CI runner posts results, set
`trustClass: "harness-observed"` and a `producer`. Without it your results are
treated as self-assertions and count for half.

`tier` is now validated against planned tiers. A value like `"adversarial"` used to
return `recorded: 1` and have no effect; it is now rejected with a message.

### 6. `main` is a module, not a script

**Was:** `require('veris-core')` ran a full repository analysis and wrote report files
to disk as an import side effect.
**Now:** it only exports.

```ts
import { GitDiffDriver, BehavioralDiffEngine, RiskModelingEngine } from 'veris-core';

const snap = new GitDiffDriver(process.cwd()).snapshot();   // throws BaselineError
const diff = new BehavioralDiffEngine().computeDiff(snap.baseGraph, snap.headGraph);
const risks = new RiskModelingEngine(process.cwd()).assessRisk(diff, snap.headGraph);
```

### 7. MCP responses are capped

Every list-shaped response is now bounded and reports what it elided:

```jsonc
{ "totalTargets": 29357, "targets": [ /* 200 */ ], "truncated": { "shown": 200, "total": 29357 } }
```

The plan response previously measured 12.28 MB and `allocate_budget` returned the
complement of its selection at 16.3 MB — enough to exhaust an agent's context window
before any of it could be read. `allocate_budget` now returns `skippedCount` instead
of the `skipped` array.

**What to do.** If you consumed full arrays, read `truncated` and page or narrow your
scope. Plan targets are ranked by node risk before capping, so the first N are the
ones worth acting on.

### 8. Scoring changed shape

Risk now uses three independent inputs. Previously 65% of the score was node degree
counted twice, saturating at degree 13 — a 13-edge node and a 500-edge node scored
identically. Class-to-own-member containment edges no longer inflate coupling.

Absolute values are not comparable with 2.x. Relative ordering is more meaningful.

---

### 9. `better-sqlite3` is now an optional dependency

**Was:** a hard dependency. Installing on a platform with no prebuilt binary fell back
to a source build requiring a C++ toolchain, so `npm install` failed outright.
**Now:** optional. npm skips it when it cannot be built, and Veris runs without
persistence.

Analysis, risk, workflows, probes and the reports all work either way. What is lost
without it is run history, drift detection across runs, and `confidence_history`.

`veris doctor` reports which mode you are in, and a run that cannot persist says so
rather than naming a state file it did not write. To force persistence on, install it
explicitly:

```bash
npm install better-sqlite3
```

On **npm 12 or later** that is not enough on its own. npm 12 stopped running
dependency install scripts by default, and better-sqlite3 fetches its prebuilt
binding from one — so the package installs, the binding never arrives, and it fails
at first use rather than at install. Allow it explicitly in **your own**
`package.json` (the allowlist is per-project and is not inherited from a dependency,
so nothing Veris declares can do this for you):

```json
{ "allowScripts": { "better-sqlite3": true } }
```

```bash
npm rebuild better-sqlite3
```

`veris doctor` distinguishes the two cases — not installed, versus installed with no
binding — because they have opposite remedies.

---

## Behaviour that is simply better

No action needed, but worth knowing what changed under you:

- **Call edges are resolved by the TypeScript checker.** 2.x matched the trailing
  identifier of a call against a global name index and drew an edge to every
  declaration sharing it — `console.log()` produced an edge to your own `Logger.log`.
  91.1% of emitted edges on a real dependency were ambiguous. Ambiguous calls now
  produce no edge, and every edge carries `resolution`.
- **ESM imports work.** `from './target.js'` never matched, so NodeNext, ESM and Deno
  codebases produced zero import edges.
- **Only git-tracked files are analyzed.** Build output and ignored directories were
  previously counted as added behaviour.
- **Nested `node_modules` are excluded.** On this repository, 1,667 of 1,735 analyzed
  files were third-party.
- **Silent rewrites are detected.** Nodes carry a normalized body hash, so a function
  rewritten while keeping its name and callees appears as `modifiedNodes` — the case
  drift detection previously claimed to catch and structurally could not.
- **Deleted workflows are reported.** Deleting an entire workflow previously printed
  "No workflow drift detected."
- **`veris analyze` works.** It resolved `./analyze`, found nothing, printed
  "Reports generated" and exited 0.
- **Reports are legible.** The dashboard went from 156 MB to under 1 MB; the markdown
  report from 6,043 lines (5,947 of them the same sentence) to about 100.

---

## Upgrading

```bash
npm install veris-core@3
npx veris-core doctor      # confirms git, base ref resolvability, plugins, native deps
npx veris-core . --base-ref=origin/main
```

Then, in order:

1. Add `fetch-depth: 0` wherever CI checks out.
2. Re-baseline any `VERIS_CONFIDENCE_THRESHOLD` gate.
3. Add `trustClass` and `producer` to whatever posts `report_execution`.
4. Update anything that stores node ids.
5. Remove `VERIS_PLUGINS_DISABLED`; add `--allow-plugins` only where you mean it.

## Staying on 2.x

Supported in the sense that it will keep working — but the fabricated baseline and
the automatic plugin execution are both present in every 2.x release and neither will
be backported. If you cannot upgrade yet, at minimum do not point 2.x at repositories
you do not control.

## Getting help

Something behaving differently and not listed here is a bug — please
[open an issue](https://github.com/vighriday/Veris/issues) with the command you ran
and what you expected.
