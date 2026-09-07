import { GraphNode } from '../models/GraphModels';
import { WorkflowDomain } from '../models/WorkflowModels';
import { RiskReport } from '../models/RiskModels';
import { loadProbes, loadRiskConfig, ProbeTemplate } from '../data/DataLoader';

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
        const cfg = loadRiskConfig(this.projectRoot).planning;
        const maxPerWorkflow = opts.maxPerWorkflow ?? cfg.probeMaxPerWorkflow;
        // A member must reach this risk to be worth a probe. The previous default
        // of 10 sat below the risk formula's own floor, so the filter below could
        // never exclude anything — a dead option presented as a control. The
        // configured value is checked against the achievable range in
        // data/risk-config.json (`planning._note`).
        const floor = opts.minRiskThreshold ?? cfg.probeMinOverallRisk;
        const probesData = loadProbes(this.projectRoot);

        const nodesById = new Map(graphNodes.map(n => [n.id, n]));
        const riskById = new Map(risks.map(r => [r.nodeId, r]));

        const probes: AdversarialProbe[] = [];
        const seen = new Set<string>();

        for (const wf of workflows) {
            // Spread the deck across the riskiest in-scope members instead of pinning
            // every probe to a single anchor: a 200-function payments workflow used to
            // get three probes all pointing at the same function, which reads as
            // "verify this one node" rather than "verify this workflow".
            // A workflow with no member above the floor is unaffected by this run.
            const anchors = wf.memberNodeIds
                .map(id => riskById.get(id))
                .filter((r): r is RiskReport =>
                    !!r && r.score.overallRisk >= floor && nodesById.has(r.nodeId))
                .sort((a, b) => b.score.overallRisk - a.score.overallRisk ||
                                (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
                .slice(0, maxPerWorkflow);
            if (anchors.length === 0) continue;

            const templates: ProbeTemplate[] = probesData.probesByKind[wf.kind] || probesData.generic;
            let emitted = 0;
            for (const p of templates.slice(0, maxPerWorkflow)) {
                // Dedup on (workflowKind, scenario) so a workflow never duplicates a probe.
                const key = `${wf.kind}|${p.scenario}`;
                if (seen.has(key)) continue;
                seen.add(key);
                probes.push({
                    // Round-robin over the anchors, highest risk first, so the first
                    // probe still lands on the riskiest member when anchors are scarce.
                    nodeId: anchors[emitted % anchors.length].nodeId,
                    workflowId: wf.id,
                    workflowKind: wf.kind,
                    category: p.category,
                    scenario: p.scenario,
                    expectedInvariant: p.expectedInvariant,
                    severity: p.severity
                });
                emitted++;
            }
        }
        return probes;
    }
}
