# Veris MCP Tool Reference

Veris exposes 17 MCP tools over stdio. Tool names are stable; the schema is versioned at `src/mcp/McpServer.ts`.

## Tool chain (state is cached per session)

| # | Tool | Purpose |
|---|------|---------|
| 1 | `analyze_repository` | Parse repo AST, count files. |
| 2 | `export_behavioral_graph` | Return nodes + edges (DependsOn + Invokes). |
| 3 | `analyze_pr_behavior` | Real git-worktree diff; impacted nodes + risk scores. |
| 4 | `generate_verification_plan` | Tier 1/2/3 directives. |
| 5 | `identify_unverified_behaviors` | Confidence using real execution history with half-life decay. |
| 6 | `list_workflows` | Auto-cluster graph into semantic domains. |
| 7 | `analyze_workflow` | Deep-dive a single workflow. |
| 8 | `detect_drift` | Fingerprint diff vs history. Silent rewrites surface here. |
| 9 | `generate_adversarial_probes` | Concrete Tier 3 hypotheses (concurrency, replay, retry storm, etc.). |
| 10 | `allocate_budget` | Greedy knapsack of highest-leverage targets within a time budget. |
| 11 | `what_if_revert` | Counterfactual: simulate reverting nodes, recompute risk. |
| 12 | `report_execution` | Close the feedback loop. Post pass/fail/flaky/skipped per target. |
| 13 | `confidence_history` | Confidence trend across last N runs. |
| 14 | `node_history` | Execution + risk history for one node. |
| 15 | `export_onboarding` | Workflow-first onboarding map (markdown per workflow). |
| 16 | `cross_repo_snapshot` | Latest confidence + drift across all registered repos. |
| 17 | `register_repo` | Add a repo to ~/.veris/registry.json. |

## Recommended flows

### "Should this PR merge?"

1. `analyze_pr_behavior(baseRef='origin/main')`
2. `list_workflows` — find the affected behaviors
3. `detect_drift` — flag silent rewrites
4. `generate_adversarial_probes` — produce the Tier 3 hypotheses
5. `allocate_budget(minutes=15)` — pick what to actually run in CI

### "We just ran some tests, update confidence"

1. `report_execution(executions=[...])` — pass `result: 'pass' | 'fail' | 'flaky' | 'skipped'` per target
2. `identify_unverified_behaviors` — re-compute with half-life-decayed history

### "What if we revert this risky refactor?"

1. `list_workflows` then `analyze_workflow(workflowId='payments')` — get member nodeIds
2. `what_if_revert(nodeIds=[...])` — see delta in risk + impacted-node count

### "Fleet-level view across services"

1. `register_repo({name: 'payments-api', path: '/path/to/payments-api'})`
2. `register_repo({name: 'billing-worker', path: '/path/to/billing-worker'})`
3. `cross_repo_snapshot` — latest run from each

## Privacy

`VERIS_STATE_DISABLED=1` disables all writes to `.veris/state.db`. The MCP server still answers tool calls but tools that require history (`confidence_history`, `node_history`, `detect_drift`) will return empty.
