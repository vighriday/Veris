import { VerificationPlan, VerificationTarget } from '../models/VerificationModels';
import { RiskReport } from '../models/RiskModels';
import { WorkflowDomain, WorkflowRiskAggregate } from '../models/WorkflowModels';

/**
 * Verification Budget Allocator: given a constrained budget (minutes, or a
 * verification count cap), picks the highest-leverage subset of verification
 * targets to actually run.
 *
 * Leverage scoring per target:
 *  - tier weight (Tier 3 buys more than Tier 1 when something goes wrong)
 *  - underlying node risk score
 *  - workflow criticality (Payments / Auth / Webhooks > Reporting / Configuration)
 *  - estimated cost in seconds (heuristic from tier)
 *
 * Solves a greedy knapsack — close to optimal for this shape, far faster than
 * exact DP and good enough for budgets in the human-minutes range.
 */

const TIER_LEVERAGE: Record<string, number> = { 'Tier 1': 1, 'Tier 2': 3, 'Tier 3': 7 };
const TIER_COST_SEC: Record<string, number> = { 'Tier 1': 5, 'Tier 2': 30, 'Tier 3': 120 };

// Workflow criticality multipliers — purely heuristic, plugin-overridable later.
const WF_CRITICALITY: Record<string, number> = {
    'Payments': 2.0, 'Authentication': 2.0, 'Authorization': 1.8, 'Webhooks': 1.8,
    'Billing': 1.7, 'Checkout': 1.7, 'Session': 1.6, 'Persistence': 1.5,
    'Queue': 1.5, 'Sync': 1.4, 'Orchestration': 1.4, 'Realtime': 1.3,
    'Caching': 1.2, 'Notifications': 1.1, 'AI': 1.5, 'Routing': 1.4,
    'Cart': 1.2, 'Search': 1.0, 'Profile': 0.9, 'Admin': 1.2, 'Analytics': 0.8,
    'Onboarding': 1.0, 'Reporting': 0.7, 'Configuration': 0.7, 'Infrastructure': 0.8,
    'Core': 1.0, 'Uncategorized': 0.7
};

export interface BudgetAllocation {
    selected: Array<VerificationTarget & { score: number; estimatedSec: number; workflowName?: string }>;
    skipped: Array<VerificationTarget & { reason: string }>;
    totalEstimatedSec: number;
    budgetSec: number;
    coverage: { tier1: number; tier2: number; tier3: number };
    narrative: string;
}

export class VerificationBudgetAllocator {
    public allocate(
        plan: VerificationPlan,
        risks: RiskReport[],
        workflows: WorkflowDomain[],
        budgetMinutes: number
    ): BudgetAllocation {
        const budgetSec = Math.max(0, Math.floor(budgetMinutes * 60));
        const riskByNode = new Map(risks.map(r => [r.nodeId, r.score.overallRisk]));
        const nodeWorkflow = new Map<string, WorkflowDomain>();
        for (const wf of workflows) for (const id of wf.memberNodeIds) nodeWorkflow.set(id, wf);

        type Scored = VerificationTarget & { score: number; estimatedSec: number; workflowName?: string };
        const scored: Scored[] = plan.targets.map(t => {
            const tierKey = t.tier.split(' - ')[0];
            const tier = TIER_LEVERAGE[tierKey] ?? 1;
            const cost = TIER_COST_SEC[tierKey] ?? 5;
            const risk = riskByNode.get(t.nodeId) ?? 10;
            const wf = nodeWorkflow.get(t.nodeId);
            const crit = wf ? (WF_CRITICALITY[wf.kind] ?? 1) : 1;
            const score = (tier * crit * (risk / 10));
            return { ...t, score: parseFloat((score / cost).toFixed(4)), estimatedSec: cost, workflowName: wf?.name };
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
