# Security Policy

## Reporting a vulnerability

Report privately via
[GitHub Security Advisories](https://github.com/vighriday/Veris/security/advisories/new).

Please do **not** open public issues for vulnerabilities.

## Threat model

Veris runs entirely on the user's machine. There is no remote service to attack.
The interesting exposure is that **Veris is pointed at repositories the operator may
not have written** — that is its primary use — so repository content is untrusted
input.

### Untrusted source repositories

Veris reads source files and invokes `git`. Both are treated as untrusted:

- Git refs supplied by the user are validated against a strict allowlist before
  reaching `git`, and every invocation uses `execFileSync` with an argument array,
  so there is no shell to inject into.
- Symbol names, file paths and narrative strings originating in analyzed source are
  HTML-escaped before they reach the generated dashboard.

### Plugins execute repository code — off by default

`<repo>/.veris/plugins/*.js` are Node modules loaded with `require()`. They run
in-process with the caller's full privileges. **There is no sandbox**, and this
document does not claim one: `require()` grants complete process capability.

Because a plugin ships *inside the repository being analyzed*, loading it
automatically would mean "analyzing a repository executes that repository's code".
Plugin execution is therefore **disabled unless explicitly enabled per run**:

```bash
veris .                      # plugins present are reported, NOT executed
veris . --allow-plugins      # explicit opt-in
VERIS_ENABLE_PLUGINS=1 veris .
```

When plugins are present but not enabled, Veris names them and continues. When they
are enabled, Veris prints each plugin's absolute path and SHA-256 **before**
executing it, so the action is attributable even if the plugin crashes the process.

Only enable plugins for repositories you trust as much as your own.

> Prior releases up to and including 2.1.8 loaded these plugins **by default**, and
> the load was reachable from read-shaped MCP tools (`list_workflows`,
> `detect_drift`, `allocate_budget`). Earlier versions of this document incorrectly
> stated that Veris "does not execute user code". If you have run an affected
> version against a repository you do not control, treat that as code execution.

### Evidence integrity

Execution results arrive over MCP from whoever is doing the verifying — frequently
the same agent whose work is being assessed. Accordingly:

- Evidence rows are **append-only and hash-chained**. A later result for the same
  target is recorded alongside the earlier one, never replacing it, so a recorded
  failure cannot be overwritten by a subsequent pass.
- Every row carries a **producer identity** and a **trust class**:
  `veris-derived`, `harness-observed`, or `agent-asserted` (the default). An
  agent's own claim is weighted below an independently observed result and cannot
  by itself raise assurance to full credit.
- `VerisState.verifyEvidenceChain()` recomputes the chain and reports the first
  sequence number that fails, so edits made directly to the SQLite file are
  detectable.

> Prior releases wrote executions with `INSERT OR REPLACE` keyed on
> `(run_id, node_id, tier)` with one run id per process, so a caller could post a
> failure and then erase it with a pass.

### MCP clients

The MCP server speaks over stdio and opens no network sockets. Tool arguments are
validated against their declared schemas before dispatch; the low-level MCP server
does not do this on its own.

### Generated reports

`veris-reports/veris-dashboard.html` is written to disk and opened in a browser.
It carries analyzed source-derived strings, all escaped. Check
[`src/reporting/ReportingEngine.ts`](src/reporting/ReportingEngine.ts) for the
current handling of any external asset the page references.

## Hardenings in place

- Git refs validated against `/^[A-Za-z0-9][A-Za-z0-9._/\-~^]{0,254}$/`; shell
  metacharacters, `..` sequences and over-long refs rejected.
- All subprocess calls use `execFileSync` with argument arrays. No shell.
- No fabricated baselines: if a real baseline cannot be established the run fails
  with a reason rather than inventing one and reporting it as a diff.
- Analysis is restricted to git-tracked files.
- HTML output escaped; dashboard JSON payload escapes `</script`, U+2028 and U+2029.
- SQLite writes are parameterized. Batches are transactional.
- `VERIS_STATE_DISABLED=1` disables all persistence.
- Read-shaped operations use a read-only state handle that creates nothing on disk.
- Registry paths are validated before being persisted.

## Out of scope

- What an enabled plugin does. Enabling plugins is an explicit grant of code
  execution, disclosed at the point of use.
- Decisions made by autonomous agents acting on Veris output. Veris emits
  directives and evidence, never actions.
- The correctness of a risk or coverage number as a prediction of real-world
  failure. These are not calibrated against observed outcomes and are not
  represented as assurance. See [`docs/internal/BUG_TRACKER.md`](docs/internal/BUG_TRACKER.md).

## Response time

Acknowledgement within 72 hours.
