import { GraphNode } from '../models/GraphModels';
import { WorkflowDomain } from '../models/WorkflowModels';
import { RiskReport } from '../models/RiskModels';
import { loadProbes, ProbeTemplate } from '../data/DataLoader';

/**
 * Concrete Tier 3 probe generator. Probe library lives in data/probes.json
 * (override at .veris/data/probes.json). Generator pairs high-risk nodes
 * with relevant scenario+invariant templates.
 *
 * Generator never executes — external agents handle execution. CI runners,
 * MCP-compatible coding agents, or humans copy directives from the dashboard.
 */
export interface AdversarialProbe {
    nodeId: string;
    workflowId?: string;
    workflowKind?: string;
    category: string;
    scenario: string;
    expectedInvariant: string;
    severity: 'low' | 'medium' | 'high';
}

export class AdversarialProbeGenerator {

    constructor(private projectRoot: string = process.cwd()) {}

    public generate(
        risks: RiskReport[],
        workflows: WorkflowDomain[],
        graphNodes: GraphNode[],
        opts: { maxPerWorkflow?: number; minRiskThreshold?: number } = {}
    ): AdversarialProbe[] {
        const maxPerWorkflow = opts.maxPerWorkflow ?? 3;
        // Workflow gets its probe deck if any member node has risk above this floor.
        // Floor is intentionally low — probes are directives ("here is what could
        // break"), not findings. The point is coverage, not noise control.
        const floor = opts.minRiskThreshold ?? 10;
        const probesData = loadProbes(this.projectRoot);

        const nodesById = new Map(graphNodes.map(n => [n.id, n]));
        const riskById = new Map(risks.map(r => [r.nodeId, r]));

        const probes: AdversarialProbe[] = [];
        const seen = new Set<string>();

        for (const wf of workflows) {
            // Highest-risk member of the workflow becomes the anchor node for the probe.
            // If no member is in scope, skip — workflow is unaffected by this run.
            let anchor: { nodeId: string; risk: number } | null = null;
            for (const id of wf.memberNodeIds) {
                const r = riskById.get(id);
                if (!r) continue;
                if (!anchor || r.score.overallRisk > anchor.risk) {
                    anchor = { nodeId: id, risk: r.score.overallRisk };
                }
            }
            if (!anchor || anchor.risk < floor) continue;
            if (!nodesById.has(anchor.nodeId)) continue;

            const templates: ProbeTemplate[] = probesData.probesByKind[wf.kind] || probesData.generic;
            for (const p of templates.slice(0, maxPerWorkflow)) {
                // Dedup on (workflowKind, scenario) so a workflow never duplicates a probe.
                const key = `${wf.kind}|${p.scenario}`;
                if (seen.has(key)) continue;
                seen.add(key);
                probes.push({
                    nodeId: anchor.nodeId,
                    workflowId: wf.id,
                    workflowKind: wf.kind,
                    category: p.category,
                    scenario: p.scenario,
                    expectedInvariant: p.expectedInvariant,
                    severity: p.severity
                });
            }
        }
        return probes;
    }
}
