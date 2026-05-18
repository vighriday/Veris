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
        opts: { maxPerNode?: number; minRiskThreshold?: number } = {}
    ): AdversarialProbe[] {
        const max = opts.maxPerNode ?? 3;
        const threshold = opts.minRiskThreshold ?? 40;
        const probesData = loadProbes(this.projectRoot);

        const nodeToWorkflow = new Map<string, WorkflowDomain>();
        for (const d of workflows) for (const id of d.memberNodeIds) nodeToWorkflow.set(id, d);

        const nodesById = new Map(graphNodes.map(n => [n.id, n]));
        const high = risks
            .filter(r => r.score.overallRisk >= threshold)
            .sort((a, b) => b.score.overallRisk - a.score.overallRisk);

        const probes: AdversarialProbe[] = [];
        for (const r of high) {
            const node = nodesById.get(r.nodeId);
            if (!node) continue;
            const wf = nodeToWorkflow.get(r.nodeId);
            const templates: ProbeTemplate[] = (wf && probesData.probesByKind[wf.kind])
                || probesData.generic;
            for (const p of templates.slice(0, max)) {
                probes.push({
                    nodeId: r.nodeId,
                    workflowId: wf?.id,
                    workflowKind: wf?.kind,
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
