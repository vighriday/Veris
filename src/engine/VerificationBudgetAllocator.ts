import { VerificationPlan, VerificationTarget } from '../models/VerificationModels';
import { RiskReport } from '../models/RiskModels';
import { WorkflowDomain } from '../models/WorkflowModels';
import { loadRiskConfig } from '../data/DataLoader';

/**
 * Verification Budget Allocator: greedy knapsack over verification targets.
 *
 * Leverage score per target =
 *   (tierLeverage × workflowCriticality × (risk/10)) / tierCostSeconds
 *
 * All weights live in data/risk-config.json (override-able at
 * .veris/data/risk-config.json). Greedy is near-optimal for budget shapes
 * in the human-minutes range.
 */

export interface BudgetAllocation {
    selected: Array<VerificationTarget & { score: number; estimatedSec: number; workflowName?: string }>;
    skipped: Array<VerificationTarget & { reason: string }>;
    totalEstimatedSec: number;
    budgetSec: number;
    coverage: { tier1: number; tier2: number; tier3: number };
    narrative: string;
}

export class VerificationBudgetAllocator {

    constructor(private projectRoot: string = process.cwd()) {}

    public allocate(
        plan: VerificationPlan,
        risks: RiskReport[],
        workflows: WorkflowDomain[],
        budgetMinutes: number
    ): BudgetAllocation {
        const cfg = loadRiskConfig(this.projectRoot).budget;
        const budgetSec = Math.max(0, Math.floor(budgetMinutes * 60));
        const riskByNode = new Map(risks.map(r => [r.nodeId, r.score.overallRisk]));
        const nodeWorkflow = new Map<string, WorkflowDomain>();
        for (const wf of workflows) for (const id of wf.memberNodeIds) nodeWorkflow.set(id, wf);

        type Scored = VerificationTarget & { score: number; estimatedSec: number; workflowName?: string };
        const scored: Scored[] = plan.targets.map(t => {
            const tierKey = t.tier.split(' - ')[0];
            const tier = cfg.tierLeverage[tierKey] ?? 1;
            const cost = cfg.tierCostSeconds[tierKey] ?? 5;
            const risk = riskByNode.get(t.nodeId) ?? 10;
            const wf = nodeWorkflow.get(t.nodeId);
            const crit = wf ? (cfg.workflowCriticality[wf.kind] ?? 1) : 1;
            const score = (tier * crit * (risk / 10)) / cost;
            return { ...t, score: parseFloat(score.toFixed(4)), estimatedSec: cost, workflowName: wf?.name };
        });

        scored.sort((a, b) => b.score - a.score);

        const selected: Scored[] = [];
        const skipped: Array<VerificationTarget & { reason: string }> = [];
        let used = 0;
        for (const t of scored) {
            if (used + t.estimatedSec <= budgetSec) {
                selected.push(t);
                used += t.estimatedSec;
            } else {
                skipped.push({ ...t, reason: 'over budget' });
            }
        }

        const coverage = {
            tier1: selected.filter(s => s.tier.startsWith('Tier 1')).length,
            tier2: selected.filter(s => s.tier.startsWith('Tier 2')).length,
            tier3: selected.filter(s => s.tier.startsWith('Tier 3')).length
        };

        const narrative = `Budget ${budgetMinutes} min — allocated ${selected.length}/${plan.targets.length} targets ` +
            `(T1=${coverage.tier1}, T2=${coverage.tier2}, T3=${coverage.tier3}). ` +
            `Estimated runtime ${Math.round(used / 60)} min of ${budgetMinutes}. ` +
            `Sorted by leverage = (tier × workflow criticality × risk) / estimated cost.`;

        return { selected, skipped, totalEstimatedSec: used, budgetSec, coverage, narrative };
    }
}
