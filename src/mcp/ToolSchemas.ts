import { EXECUTION_RESULTS, TRUST_CLASSES } from '../persistence/VerisState';

/**
 * Tool definitions and argument validation.
 *
 * Two reasons this is a separate module rather than inline in the server:
 *
 * 1. The low-level MCP `Server` does not validate arguments against the
 *    `inputSchema` it advertises, so those schemas were documentation that looked
 *    like enforcement. Validation lives next to the schema here, so the two cannot
 *    drift apart.
 *
 * 2. Agents choose tools by reading descriptions. A description that overstates what
 *    a handler returns is a functional defect, not a docs nit — it causes wrong tool
 *    selection. Eight of these previously contradicted their handlers (promising full
 *    graph arrays that returned five sample nodes, claiming graph-based clustering
 *    that reads only filenames, naming an output file that is not written). Each
 *    description below states what the handler actually does, including its limits.
 */

export class ToolValidationError extends Error {}

type Validator = (args: Record<string, unknown>) => Record<string, unknown>;

const NO_ARGS: Validator = () => ({});

function requireString(args: Record<string, unknown>, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || v.trim() === '') {
        throw new ToolValidationError(`'${key}' is required and must be a non-empty string`);
    }
    return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.trim() === '') {
        throw new ToolValidationError(`'${key}' must be a non-empty string when provided`);
    }
    return v;
}

function optionalPositiveNumber(args: Record<string, unknown>, key: string): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) {
        throw new ToolValidationError(`'${key}' must be a positive number`);
    }
    return n;
}

export const TOOL_DEFINITIONS = [
    {
        name: "analyze_repository",
        description:
            "Parses the git-tracked TypeScript and JavaScript files in the current repository via ts-morph and returns a structural summary: file, class, method, function and exported-function counts, a per-file breakdown (capped at 100 files, ranked by declaration count), and call-resolution statistics showing how many call sites the TypeScript checker resolved exactly versus left ambiguous. Untracked and ignored files are excluded. Results are cached until a source file changes on disk.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "export_behavioral_graph",
        description:
            "Exports the behavioral graph as JSON. Nodes are classes, methods, constructors, accessors and top-level functions, each tagged with its inferred workflow domain; edges are DependsOn (containment and imports) and Invokes (call targets). Every edge carries a 'resolution' field: 'resolved' means the TypeScript checker identified the target, 'heuristic' means exactly one declaration matched by name, 'structural' means containment or import. Calls whose target is ambiguous produce no edge at all. Returns full counts plus up to 500 nodes and 1000 edges, with a 'truncated' field when the graph is larger.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "analyze_pr_behavior",
        description:
            "Computes a behavioral diff between the working tree and the merge-base of HEAD with a base ref, using a detached git worktree. Returns added, removed and modified node counts (modified = same declaration, changed body hash — a rewrite that keeps its name and callees), the affected workflows with narratives, and the top 25 nodes by risk. Reports whether the working tree was dirty, since that makes the result non-reproducible from commits alone. Requires a git repository with a resolvable base ref: if none exists the call returns an error rather than a fabricated baseline. Base ref defaults to origin/main, then origin/master, main, master, HEAD~1.",
        inputSchema: {
            type: "object",
            properties: {
                baseRef: { type: "string", description: "Git ref to find the merge-base against. Example: 'origin/develop' or a commit SHA." }
            },
            required: []
        }
    },
    {
        name: "generate_verification_plan",
        description:
            "Generates a tiered verification plan for every impacted node. Tier 1 is structural (lint, schema, types), Tier 2 behavioral (contracts, integration boundaries), Tier 3 adversarial (concurrency, idempotency, retries, replay, partial failure). Directives are templates parameterized by node id — for concrete failure scenarios use generate_adversarial_probes instead. Returns tier counts plus up to 200 targets ranked by node risk, with a 'truncated' field when there are more.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "identify_unverified_behaviors",
        description:
            "Returns verification coverage: how much of the planned work has supporting execution evidence, weighted by tier, decayed by age, and weighted by trust class (agent-asserted evidence counts for half). Also returns the count of failing and flaky targets, the highest single impacted-node risk, and the specific unverified assumptions (capped at 20). 'overallConfidence' is an alias of coverage retained for compatibility — it measures evidence, not the probability that the code is correct, and is not calibrated against observed outcomes. Coverage is reported as unknown, not 100%, when nothing was planned.",
        inputSchema: {
            type: "object",
            properties: {
                executedTargetsCount: { type: "number", description: "What-if override: model coverage as if this many targets had been executed. Only applies when persistent state is unavailable." }
            },
            required: []
        }
    },
    {
        name: "list_workflows",
        description:
            "Groups repository nodes into semantic domains (Authentication, Payments, Webhooks, Caching, Queue and 20 more) and returns per-workflow member counts, impact counts, risk aggregates, narrative and runtime-risk hypotheses. Classification is a weighted keyword vote over directory segments, import specifiers and symbol names — it does not traverse the call graph, so a workflow is a labelled set of declarations rather than an execution path. Nodes matching no rule are grouped as Uncategorized. Returns up to 50 workflows.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "analyze_workflow",
        description:
            "Deep-dive on one workflow by id: member nodes (up to 500), the inference signals that placed each member there with their weights, the top 5 members by risk with full score breakdowns, and runtime-risk hypotheses. Use after list_workflows identifies the workflow you care about.",
        inputSchema: {
            type: "object",
            properties: {
                workflowId: { type: "string", description: "Workflow identifier from list_workflows (e.g. 'payments', 'authentication')." }
            },
            required: ["workflowId"]
        }
    },
    {
        name: "detect_drift",
        description:
            "Compares current workflow fingerprints against those from prior runs in .veris/state.db. A fingerprint is the SHA-256 of the workflow's sorted member ids, its internal edge signatures, and each member's normalized body hash — so a rewritten function body is detected even when its name and call targets are unchanged. Member ids are repository-relative, so renaming a directory does not register as drift. Surfaces added, removed, expanded, contracted and silently-rewritten workflows, and distinguishes a first observation from an absence of drift. Persists the current fingerprints for future comparisons.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "generate_adversarial_probes",
        description:
            "Returns concrete Tier-3 failure scenarios for the affected workflows, each paired with the invariant that must hold — for example 'submit charge twice with the same idempotency key inside 500ms; exactly one ledger entry'. Probes are selected from a curated per-domain library (concurrency, idempotency, retry storms, replay, partial failure, cache stampede, ordering); they are not generated from your code, so they name the failure mode rather than the specific call site. Returns up to 100.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "allocate_budget",
        description:
            "Given a time budget in minutes, greedily selects the highest-leverage subset of verification targets that fits, ranked by (tier leverage x workflow criticality x node risk) / estimated cost. Returns the selected targets in execution order (up to 200), the counts selected and skipped, estimated seconds and coverage. The skipped list itself is not returned — it is the complement of the selection and can be the entire plan.",
        inputSchema: {
            type: "object",
            properties: {
                minutes: { type: "number", description: "Minutes available. Typical: 5 (quick check), 15 (default), 60 (pre-release sweep)." }
            },
            required: ["minutes"]
        }
    },
    {
        name: "what_if_revert",
        description:
            "Counterfactual: removes the named nodes from the head graph, recomputes the diff and risk against the real baseline, and reports what changes. Answers 'what recovers if I revert this?'. Models deletion only — it cannot model reverting a modified body back to its prior form. Requires a resolvable baseline; returns an error rather than a fabricated one.",
        inputSchema: {
            type: "object",
            properties: {
                nodeIds: {
                    type: "array", items: { type: "string" },
                    description: "Node ids to remove. Format: 'relative/path.ts::Symbol' or 'relative/path.ts::Class::method', as returned by export_behavioral_graph."
                }
            },
            required: ["nodeIds"]
        }
    },
    {
        name: "report_execution",
        description:
            "Posts verification results back to Veris. Evidence is append-only and hash-chained: a later record for the same target is added alongside the earlier one, never replacing it, so a failure cannot be overwritten by a subsequent pass. Each record carries a trust class — 'agent-asserted' (default; the caller's own claim, counts at half weight), 'harness-observed' (an external runner observed it), or 'veris-derived' — and a producer identity. Accepts a batch, written in one transaction: if any entry is invalid, none are recorded.",
        inputSchema: {
            type: "object",
            properties: {
                executions: {
                    type: "array",
                    description: "Batch of results.",
                    items: {
                        type: "object",
                        properties: {
                            nodeId: { type: "string" },
                            tier: { type: "string", description: "Tier label, e.g. 'Tier 1 - Structural Verification'. Must match a planned tier." },
                            result: { type: "string", enum: [...EXECUTION_RESULTS] },
                            directive: { type: "string" },
                            workflowId: { type: "string" },
                            detail: { type: "string" },
                            durationMs: { type: "number" },
                            trustClass: { type: "string", enum: [...TRUST_CLASSES] },
                            producer: { type: "string", description: "Who produced this result, e.g. 'github-actions:test' or an agent name." }
                        },
                        required: ["nodeId", "tier", "result"]
                    }
                }
            },
            required: ["executions"]
        }
    },
    {
        name: "confidence_history",
        description:
            "Returns verification-coverage and execution-depth values across recent runs recorded in .veris/state.db, newest first. Defaults to 30 runs, capped at 100. Returns an empty trend with stateEnabled:false when persistence is disabled (VERIS_STATE_DISABLED=1).",
        inputSchema: {
            type: "object",
            properties: { limit: { type: "number", description: "Maximum runs to return. Default 30, maximum 100." } },
            required: []
        }
    },
    {
        name: "node_history",
        description:
            "Timeline for one node: its risk and blast-radius values across previous runs, plus every execution-evidence record posted against it with result, tier, trust class, producer and timestamp. Use for forensics ('this function broke production — what does its history look like?') or to check whether a high-risk node has accumulated trustworthy passing evidence.",
        inputSchema: {
            type: "object",
            properties: { nodeId: { type: "string", description: "Node id. Format: 'relative/path.ts::Symbol' or 'relative/path.ts::Class::method'." } },
            required: ["nodeId"]
        }
    },
    {
        name: "export_onboarding",
        description:
            "Writes a workflow-first onboarding package under veris-reports/onboarding/: one markdown file per workflow describing its purpose, members, risks and suggested first reads, plus a README.md index. Returns the output directory and the paths written.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "cross_repo_snapshot",
        description:
            "Reads the last recorded run for each repository registered in ~/.veris/registry.json and returns their coverage values, weakest first. Reports repositories that have no Veris state yet as 'no data' rather than analyzing them — this tool reads existing state and never runs an analysis or writes to a registered repository.",
        inputSchema: { type: "object", properties: {}, required: [] }
    },
    {
        name: "register_repo",
        description:
            "Adds a repository to the user-level registry at ~/.veris/registry.json so cross_repo_snapshot includes it. The path must exist, be a directory, and contain a .git directory. Setup-time call, typically run once per repository.",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Human-readable name shown in snapshots." },
                path: { type: "string", description: "Absolute path to the repository root." },
                tags: { type: "array", items: { type: "string" }, description: "Optional grouping tags, e.g. ['prod','checkout']." }
            },
            required: ["name", "path"]
        }
    }
] as const;

const VALIDATORS: Record<string, Validator> = {
    analyze_repository: NO_ARGS,
    export_behavioral_graph: NO_ARGS,
    list_workflows: NO_ARGS,
    detect_drift: NO_ARGS,
    generate_adversarial_probes: NO_ARGS,
    generate_verification_plan: NO_ARGS,
    export_onboarding: NO_ARGS,
    cross_repo_snapshot: NO_ARGS,

    analyze_pr_behavior: (a) => ({ baseRef: optionalString(a, 'baseRef') }),

    identify_unverified_behaviors: (a) => {
        const v = a.executedTargetsCount;
        if (v === undefined || v === null) return {};
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n) || n < 0) {
            throw new ToolValidationError("'executedTargetsCount' must be a non-negative number");
        }
        return { executedTargetsCount: n };
    },

    analyze_workflow: (a) => ({ workflowId: requireString(a, 'workflowId') }),

    allocate_budget: (a) => {
        const minutes = optionalPositiveNumber(a, 'minutes');
        if (minutes === undefined) throw new ToolValidationError("'minutes' is required and must be a positive number");
        return { minutes };
    },

    what_if_revert: (a) => {
        const v = a.nodeIds;
        if (!Array.isArray(v) || v.length === 0) {
            throw new ToolValidationError("'nodeIds' is required and must be a non-empty array of strings");
        }
        if (!v.every(x => typeof x === 'string' && x.trim() !== '')) {
            throw new ToolValidationError("'nodeIds' must contain only non-empty strings");
        }
        return { nodeIds: v as string[] };
    },

    report_execution: (a) => {
        const v = a.executions;
        if (!Array.isArray(v)) {
            throw new ToolValidationError("'executions' is required and must be an array");
        }
        if (v.length === 0) {
            throw new ToolValidationError("'executions' must contain at least one record");
        }
        v.forEach((e: any, i: number) => {
            const at = `executions[${i}]`;
            if (!e || typeof e !== 'object') throw new ToolValidationError(`${at} must be an object`);
            if (typeof e.nodeId !== 'string' || !e.nodeId.trim()) throw new ToolValidationError(`${at}.nodeId must be a non-empty string`);
            if (typeof e.tier !== 'string' || !e.tier.trim()) throw new ToolValidationError(`${at}.tier must be a non-empty string`);
            if (!EXECUTION_RESULTS.includes(e.result)) {
                // Silently accepting an unknown result meant `recorded: 1` for a row
                // that could never affect anything downstream.
                throw new ToolValidationError(`${at}.result must be one of: ${EXECUTION_RESULTS.join(', ')} (got ${JSON.stringify(e.result)})`);
            }
            if (e.trustClass !== undefined && !TRUST_CLASSES.includes(e.trustClass)) {
                throw new ToolValidationError(`${at}.trustClass must be one of: ${TRUST_CLASSES.join(', ')}`);
            }
            if (e.durationMs !== undefined && (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0)) {
                throw new ToolValidationError(`${at}.durationMs must be a non-negative number`);
            }
        });
        return { executions: v };
    },

    confidence_history: (a) => ({ limit: optionalPositiveNumber(a, 'limit') }),

    node_history: (a) => ({ nodeId: requireString(a, 'nodeId') }),

    register_repo: (a) => {
        const name = requireString(a, 'name');
        if (name.length > 200) throw new ToolValidationError("'name' must be 200 characters or fewer");
        const repoPath = requireString(a, 'path');
        const tags = a.tags;
        if (tags !== undefined) {
            if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')) {
                throw new ToolValidationError("'tags' must be an array of strings");
            }
        }
        return { name, path: repoPath, tags };
    }
};

export function validateToolArgs(toolName: string, args: unknown): Record<string, any> {
    const validator = VALIDATORS[toolName];
    if (!validator) throw new ToolValidationError(`Unknown tool: ${toolName}`);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new ToolValidationError('arguments must be an object');
    }
    return validator(args as Record<string, unknown>);
}
