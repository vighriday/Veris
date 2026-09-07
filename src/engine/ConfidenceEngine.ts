import { RiskReport } from '../models/RiskModels';
import { VerificationPlan, ConfidenceReport } from '../models/VerificationModels';
import { VerisState, EvidenceRecord, TrustClass } from '../persistence/VerisState';
import { loadRiskConfig } from '../data/DataLoader';

/**
 * Verification coverage engine.
 *
 * WHAT THIS DOES AND DOES NOT CLAIM — read before reusing the numbers.
 *
 * This engine measures how much of the planned verification work has evidence
 * behind it, and how fresh and how trustworthy that evidence is. Those are real,
 * checkable quantities.
 *
 * It does NOT estimate the probability that the code is correct. The composite
 * "confidence" score it used to publish was never calibrated against observed
 * outcomes: with no execution history its reachable range was a hard [10, 45]
 * regardless of the repository, so a fresh run on flawless code and a fresh run on
 * broken code produced the same band. Reporting that as confidence asserted an
 * assurance nobody had measured.
 *
 * `overallConfidence` is retained for API compatibility and is now defined plainly
 * as tier-weighted, time-decayed, trust-weighted evidence coverage — the same thing
 * as `executionDepth`. Consumers should prefer the named fields below, and gates
 * should key on coverage rather than on a synthetic score. See docs/internal/BUG_TRACKER.md
 * findings C2-C8.
 *
 * Trust weighting: an `agent-asserted` pass — the agent under evaluation reporting
 * its own success — counts for less than a `harness-observed` one. An agent cannot
 * raise its own assurance to full credit by asserting harder.
 */

export interface ConfidenceOptions {
    halfLifeDays?: number;
    state?: VerisState;
    nodeWorkflowMap?: Record<string, string>;
    projectRoot?: string;
    /** Clock injection for deterministic tests. */
    now?: number;
}

/** Multiplier applied to earned credit, by how the evidence was obtained. */
const TRUST_WEIGHT: Record<TrustClass, number> = {
    'veris-derived': 1.0,
    'harness-observed': 1.0,
    'agent-asserted': 0.5
};

/** Cap on how many distinct assumption strings are emitted. See finding F2. */
const MAX_ASSUMPTIONS = 20;

export class ConfidenceEngine {

    public calculateConfidence(
        riskReports: RiskReport[],
        plan: VerificationPlan,
        executedTargetsCount: number = 0,
        opts: ConfidenceOptions = {}
    ): ConfidenceReport {
        const cfg = loadRiskConfig(opts.projectRoot ?? process.cwd()).confidence;
        const halfLife = opts.halfLifeDays ?? cfg.halfLifeDays;
        const now = opts.now ?? Date.now();

        const explanation: string[] = [];
        const assumptions: string[] = [];

        // Risk summary uses the maximum, not the mean. Averaging let ten trivial files
        // dilute one dangerous one, so adding harmless changes raised the score — the
        // dangerous node is exactly as dangerous either way.
        const maxRisk = riskReports.reduce((m, r) => Math.max(m, r.score.overallRisk), 0);
        const highRiskCount = riskReports.filter(r => r.score.overallRisk >= 50).length;

        const evidenceByNode = new Map<string, EvidenceRecord[]>();
        const stateActive = !!(opts.state && opts.state.enabled);
        if (stateActive) {
            for (const target of plan.targets) {
                const recs = opts.state!.executionsForNode(target.nodeId);
                if (recs.length > 0) evidenceByNode.set(target.nodeId, recs);
            }
        }

        let earned = 0;
        let possible = 0;
        let failing = 0;
        let flaky = 0;
        let agentAssertedOnly = 0;

        for (const target of plan.targets) {
            const tierKey = target.tier.split(' - ')[0];
            const weight = cfg.tierWeight[tierKey] ?? 1;
            possible += weight;

            const matching = (evidenceByNode.get(target.nodeId) || [])
                .filter(r => r.tier.startsWith(tierKey));
            if (matching.length === 0) continue;

            // Evidence is append-only, so the same target can carry several records.
            // Take the most recent, and treat a failure as authoritative over a later
            // pass from a *less* trusted producer — otherwise an agent could bury a
            // harness-observed failure under its own assertion.
            const sorted = [...matching].sort((a, b) => (b.executedAt || '').localeCompare(a.executedAt || ''));
            const latest = sorted[0];
            const authoritativeFailure = sorted.find(r =>
                r.result === 'fail' && TRUST_WEIGHT[r.trustClass] > TRUST_WEIGHT[latest.trustClass]);
            const effective = authoritativeFailure ?? latest;

            const ageDays = Math.max(0, now - Date.parse(effective.executedAt || new Date(now).toISOString())) / 86_400_000;
            const decay = Math.pow(0.5, ageDays / halfLife);
            const trust = TRUST_WEIGHT[effective.trustClass] ?? TRUST_WEIGHT['agent-asserted'];

            if (effective.result === 'pass') {
                earned += weight * decay * trust;
                if (effective.trustClass === 'agent-asserted') agentAssertedOnly++;
            } else if (effective.result === 'fail') {
                failing++;
                assumptions.push(`Recorded failure: ${effective.nodeId} (${tierKey}, ${effective.trustClass}).`);
            } else if (effective.result === 'flaky') {
                // Flaky earns nothing. It previously earned half credit *and* took a
                // penalty in the same branch, so the two partially cancelled by an
                // amount that depended on unrelated config values.
                flaky++;
            }
        }

        // Explicit override for what-if questions ("what if 5 more targets ran?").
        // Previously unreachable: the CLI hardcoded 0 and the MCP path always took the
        // state branch, so a documented parameter did nothing.
        const usingOverride = executedTargetsCount > 0 && !stateActive;
        if (usingOverride) {
            possible = plan.targets.length;
            earned = Math.min(executedTargetsCount, plan.targets.length);
        }

        let coverage: number | null;
        if (possible === 0) {
            // Nothing planned is not everything verified. Reporting 100% here read as
            // "fully verified" for a repository nobody had looked at.
            coverage = null;
            explanation.push('No verification targets were planned, so coverage is unknown rather than complete.');
        } else {
            coverage = (earned / possible) * 100;
        }

        const coverageRounded = coverage === null ? 0 : parseFloat(coverage.toFixed(2));

        if (coverage === null) {
            // nothing further to say about coverage
        } else if (coverageRounded >= 100) {
            explanation.push('Every planned verification target has recent supporting evidence.');
        } else if (coverageRounded === 0) {
            explanation.push(
                stateActive
                    ? 'No execution evidence recorded for any planned target. Coverage is 0%.'
                    : 'No execution state available, so no target can be shown as verified.'
            );
        } else {
            // Compare the value actually displayed. Comparing the raw float made 99.999%
            // print "penalized due to missing coverage (decayed depth 100.0%)".
            explanation.push(`Evidence covers ${coverageRounded}% of planned verification weight, after time decay and trust weighting.`);
        }

        if (failing > 0) {
            explanation.push(`${failing} planned target${failing === 1 ? ' has' : 's have'} a recorded failure.`);
        }
        if (flaky > 0) {
            explanation.push(`${flaky} target${flaky === 1 ? '' : 's'} reported flaky; flaky results earn no coverage credit.`);
        }
        if (agentAssertedOnly > 0) {
            explanation.push(
                `${agentAssertedOnly} passing target${agentAssertedOnly === 1 ? ' is' : 's are'} supported only by agent-asserted evidence, ` +
                `which counts at ${TRUST_WEIGHT['agent-asserted']}x. An executor-observed result would count fully.`
            );
        }
        if (maxRisk > 0) {
            explanation.push(`Highest impacted-node risk is ${maxRisk.toFixed(1)}/100 across ${riskReports.length} impacted node${riskReports.length === 1 ? '' : 's'}.`);
        }

        if (coverage !== null && coverageRounded < 100) {
            assumptions.push('Unexecuted adversarial targets may hide behavioral edge cases.');
        }

        // Fragility assumptions are deduplicated and capped. This loop previously
        // emitted one string per qualifying node with no limit: on this repository it
        // produced 5,947 copies of the same sentence, 98% of the markdown report.
        const fragile = riskReports
            .filter(r => r.score.dependencyFragility > cfg.fragilityAssumptionThreshold)
            .sort((a, b) => b.score.dependencyFragility - a.score.dependencyFragility);

        const room = Math.max(0, MAX_ASSUMPTIONS - assumptions.length);
        for (const r of fragile.slice(0, room)) {
            assumptions.push(`Densely coupled node ${r.nodeId} (fragility ${r.score.dependencyFragility}/100) may carry integration drift that standard planning does not cover.`);
        }
        if (fragile.length > room) {
            assumptions.push(`...and ${fragile.length - room} further densely coupled node${fragile.length - room === 1 ? '' : 's'} not listed. See the dashboard for the full set.`);
        }

        return {
            overallConfidence: coverageRounded,
            executionDepth: coverageRounded,
            coverageKnown: coverage !== null,
            plannedTargets: plan.targets.length,
            failingTargets: failing,
            flakyTargets: flaky,
            maxImpactedRisk: parseFloat(maxRisk.toFixed(2)),
            highRiskNodeCount: highRiskCount,
            unverifiedAssumptions: assumptions,
            explanation
        };
    }
}
