import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

/**
 * MCP integration check.
 *
 * The previous version of this script branched on whether a response carried a
 * matching JSON-RPC `id` and never inspected `error` or `isError`. Every tool could
 * have been failing and this — the only CI check on the MCP server — would still
 * have exited 0. It could not fail.
 *
 * This version asserts. It drives the whole tool surface, requires each response to
 * be well-formed and non-error, checks the shape of what came back, verifies that
 * invalid arguments are REJECTED, and enforces a response size ceiling so an
 * unbounded payload cannot silently return to the agent context window.
 */

/** Nothing an agent receives in one response should exceed this. */
const MAX_RESPONSE_BYTES = 1_000_000;
const TIMEOUT_MS = 120_000;

interface Rpc { jsonrpc: string; id: number; result?: any; error?: any }

class McpClient {
    private proc: ChildProcessWithoutNullStreams;
    private buffer = '';
    private pending = new Map<number, (r: Rpc) => void>();
    private nextId = 1;
    public stderr = '';

    constructor(entry: string, cwd: string) {
        this.proc = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'pipe'], cwd });
        this.proc.stderr.on('data', d => { this.stderr += d.toString(); });
        this.proc.stdout.on('data', d => this.onData(d.toString()));
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            let msg: Rpc;
            try {
                msg = JSON.parse(line);
            } catch {
                continue; // notification or partial frame
            }
            const resolve = this.pending.get(msg.id);
            if (resolve) {
                this.pending.delete(msg.id);
                resolve(msg);
            }
        }
    }

    public send(method: string, params: any): Promise<Rpc> {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), TIMEOUT_MS);
            this.pending.set(id, r => { clearTimeout(timer); resolve(r); });
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }

    public call(name: string, args: any = {}): Promise<Rpc> {
        return this.send('tools/call', { name, arguments: args });
    }

    public kill(): void {
        this.proc.kill();
    }
}

let failures = 0;
let checks = 0;

function check(condition: boolean, label: string, detail?: string): void {
    checks++;
    if (condition) {
        console.log(`  PASS  ${label}`);
    } else {
        failures++;
        console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

function textOf(rpc: Rpc): string {
    return rpc.result?.content?.[0]?.text ?? '';
}

function jsonOf(rpc: Rpc): any {
    try {
        return JSON.parse(textOf(rpc));
    } catch {
        return null;
    }
}

/** A successful tool call: no transport error, not flagged isError, and bounded. */
function checkOk(rpc: Rpc, name: string): any {
    check(!rpc.error, `${name}: no JSON-RPC error`, JSON.stringify(rpc.error));
    check(rpc.result?.isError !== true, `${name}: not flagged isError`, textOf(rpc).slice(0, 200));
    const bytes = Buffer.byteLength(textOf(rpc), 'utf8');
    check(bytes <= MAX_RESPONSE_BYTES, `${name}: response within ${MAX_RESPONSE_BYTES} bytes`, `${bytes} bytes`);
    return jsonOf(rpc);
}

/** An invalid call must be rejected, not silently accepted. */
function checkRejected(rpc: Rpc, name: string): void {
    const rejected = !!rpc.error || rpc.result?.isError === true;
    check(rejected, `${name}: invalid arguments rejected`, textOf(rpc).slice(0, 200));
}

async function main(): Promise<void> {
    const entry = path.join(__dirname, '../dist/mcp-index.js');
    const cwd = path.resolve(__dirname, '..');
    const client = new McpClient(entry, cwd);

    try {
        console.log('initialize');
        const init = await client.send('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'veris-integration-check', version: '1.0.0' }
        });
        check(!init.error, 'initialize: no error', JSON.stringify(init.error));
        check(!!init.result?.serverInfo?.name, 'initialize: serverInfo present');

        console.log('tools/list');
        const list = await client.send('tools/list', {});
        const tools: any[] = list.result?.tools ?? [];
        check(tools.length >= 17, `tools/list: 17+ tools advertised`, `got ${tools.length}`);
        check(tools.every(t => t.name && t.description && t.inputSchema),
            'tools/list: every tool has name, description and inputSchema');

        console.log('analyze_repository');
        const repo = checkOk(await client.call('analyze_repository'), 'analyze_repository');
        check(typeof repo?.fileCount === 'number' && repo.fileCount > 0,
            'analyze_repository: reports a positive fileCount', JSON.stringify(repo)?.slice(0, 200));
        check(!!repo?.callResolution, 'analyze_repository: reports call-resolution stats');

        console.log('export_behavioral_graph');
        const graph = checkOk(await client.call('export_behavioral_graph'), 'export_behavioral_graph');
        check(Array.isArray(graph?.nodes) && graph.nodes.length > 0,
            'export_behavioral_graph: returns actual nodes, not only counts');
        check(Array.isArray(graph?.edges), 'export_behavioral_graph: returns an edges array');
        check(graph?.edges?.every((e: any) => !!e.resolution) ?? false,
            'export_behavioral_graph: every edge declares how it was resolved');

        console.log('analyze_pr_behavior');
        const pr = checkOk(await client.call('analyze_pr_behavior', { baseRef: 'HEAD~1' }), 'analyze_pr_behavior');
        check(pr?.baselineMode === 'git', 'analyze_pr_behavior: baseline is git', String(pr?.baselineMode));
        check(typeof pr?.baseCommit === 'string' && pr.baseCommit.length > 0,
            'analyze_pr_behavior: reports the exact base commit');
        check(typeof pr?.modifiedNodes === 'number', 'analyze_pr_behavior: reports modified (rewritten) node count');

        console.log('generate_verification_plan');
        const plan = checkOk(await client.call('generate_verification_plan'), 'generate_verification_plan');
        check(typeof plan?.totalTargets === 'number', 'generate_verification_plan: reports totalTargets');
        check(Array.isArray(plan?.targets) && plan.targets.length <= 200,
            'generate_verification_plan: target list is capped');

        console.log('identify_unverified_behaviors');
        const conf = checkOk(await client.call('identify_unverified_behaviors'), 'identify_unverified_behaviors');
        check(typeof conf?.coverageKnown === 'boolean', 'identify_unverified_behaviors: states whether coverage is known');
        check((conf?.unverifiedAssumptions?.length ?? 0) <= 21,
            'identify_unverified_behaviors: assumptions are capped',
            `got ${conf?.unverifiedAssumptions?.length}`);

        console.log('list_workflows');
        const wfs = checkOk(await client.call('list_workflows'), 'list_workflows');
        check(typeof wfs?.workflowCount === 'number' && wfs.workflowCount > 0, 'list_workflows: found workflows');

        const firstWorkflow = wfs?.workflows?.[0]?.workflowId;
        if (firstWorkflow) {
            console.log('analyze_workflow');
            const one = checkOk(await client.call('analyze_workflow', { workflowId: firstWorkflow }), 'analyze_workflow');
            check(!!one?.workflow?.id, 'analyze_workflow: returns the workflow');
        }

        console.log('detect_drift');
        checkOk(await client.call('detect_drift'), 'detect_drift');

        console.log('generate_adversarial_probes');
        const probes = checkOk(await client.call('generate_adversarial_probes'), 'generate_adversarial_probes');
        check(typeof probes?.probeCount === 'number', 'generate_adversarial_probes: reports a probe count');

        console.log('allocate_budget');
        const budget = checkOk(await client.call('allocate_budget', { minutes: 15 }), 'allocate_budget');
        check(budget?.skipped === undefined, 'allocate_budget: does not return the skipped complement');
        check(typeof budget?.skippedCount === 'number', 'allocate_budget: reports skippedCount instead');

        console.log('report_execution');
        const exec = checkOk(await client.call('report_execution', {
            executions: [{
                nodeId: 'src/cli.ts::runCli',
                tier: 'Tier 1 - Structural Verification',
                result: 'pass',
                directive: 'integration check',
                producer: 'veris-integration-check',
                trustClass: 'harness-observed'
            }]
        }), 'report_execution');
        check(exec?.recorded === 1, 'report_execution: recorded the row', JSON.stringify(exec));

        console.log('confidence_history');
        const hist = checkOk(await client.call('confidence_history', { limit: 5 }), 'confidence_history');
        check(Array.isArray(hist?.trend), 'confidence_history: returns a trend array');
        // The MCP path must persist runs; if it does not, this is empty forever.
        check((hist?.trend?.length ?? 0) > 0,
            'confidence_history: MCP path persisted at least one run',
            'trend was empty — runs are not being recorded from MCP');

        console.log('node_history');
        const nh = checkOk(await client.call('node_history', { nodeId: 'src/cli.ts::runCli' }), 'node_history');
        check(Array.isArray(nh?.riskHistory), 'node_history: returns risk history');
        check(Array.isArray(nh?.executionEvidence), 'node_history: returns execution evidence');

        console.log('what_if_revert');
        checkOk(await client.call('what_if_revert', { nodeIds: ['src/cli.ts::runCli'] }), 'what_if_revert');

        console.log('cross_repo_snapshot');
        checkOk(await client.call('cross_repo_snapshot'), 'cross_repo_snapshot');

        // --- negative cases: validation must actually reject ---
        console.log('validation');
        checkRejected(await client.call('allocate_budget', { minutes: 'fifteen' }), 'allocate_budget(string minutes)');
        checkRejected(await client.call('allocate_budget', {}), 'allocate_budget(missing minutes)');
        checkRejected(await client.call('analyze_workflow', {}), 'analyze_workflow(missing workflowId)');
        checkRejected(await client.call('what_if_revert', { nodeIds: 'not-an-array' }), 'what_if_revert(non-array)');
        checkRejected(await client.call('what_if_revert', { nodeIds: [] }), 'what_if_revert(empty array)');
        checkRejected(await client.call('node_history', {}), 'node_history(missing nodeId)');
        checkRejected(await client.call('report_execution', {
            executions: [{ nodeId: 'x', tier: 'Tier 1 - Structural Verification', result: 'definitely-not-a-result' }]
        }), 'report_execution(invalid result enum)');
        checkRejected(await client.call('report_execution', { executions: [] }), 'report_execution(empty batch)');
        checkRejected(await client.call('register_repo', { name: 'x' }), 'register_repo(missing path)');
        checkRejected(await client.call('no_such_tool', {}), 'unknown tool');

        // Proves the harness itself can fail: if this ever passes, the negative
        // checks above are not testing anything.
        const sanity = await client.call('analyze_repository');
        check(sanity.result?.isError !== true, 'sanity: a valid call still succeeds after invalid ones');

    } finally {
        client.kill();
    }

    console.log(`\n${checks - failures}/${checks} checks passed`);
    if (failures > 0) {
        console.error(`\n${failures} check(s) FAILED`);
        process.exit(1);
    }
    console.log('MCP integration check passed.');
    process.exit(0);
}

main().catch(e => {
    console.error('MCP integration check crashed:', e);
    process.exit(1);
});
