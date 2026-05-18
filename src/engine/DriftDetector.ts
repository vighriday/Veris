import { VerisState, FingerprintRecord } from '../persistence/VerisState';
import { WorkflowFingerprint } from './WorkflowFingerprint';

/**
 * Detects behavioral drift over time by comparing the current fingerprint
 * for each workflow against historical fingerprints stored in VerisState.
 *
 * "Drift" surfaces:
 *  - silent rewrites: same members, different internal edge topology.
 *  - membership expansion: surface area growing run-over-run.
 *  - membership shrink: nodes leaving a workflow (potential extraction or regression).
 *  - oscillation: fingerprint flipping back and forth (refactor instability).
 */
export interface WorkflowDriftReport {
    workflowId: string;
    workflowName: string;
    currentFingerprint: string;
    previousFingerprint: string | null;
    changedSinceLastRun: boolean;
    distinctFingerprintsObserved: number;
    memberCountTrend: number[];   // most recent first
    oscillationDetected: boolean;
    memberChange: number;         // current - previous
    narrative: string;
}

export interface DriftReport {
    runId: string;
    workflows: WorkflowDriftReport[];
    summary: string;
}

export class DriftDetector {
    public detect(
        runId: string,
        current: WorkflowFingerprint[],
        state: VerisState | null
    ): DriftReport {
        const out: WorkflowDriftReport[] = [];
        let driftedCount = 0;
        let silentRewriteCount = 0;

        for (const cur of current) {
            const history: FingerprintRecord[] = state && state.enabled
                ? state.fingerprintHistory(cur.workflowId, 20)
                : [];
            // history is newest-first per VerisState
            const previous = history[0] || null;
            const previousFp = previous ? previous.fingerprint : null;
            const distinct = new Set(history.map(h => h.fingerprint));
            distinct.add(cur.fingerprint);
            const changed = previousFp !== null && previousFp !== cur.fingerprint;
            const memberChange = previous ? cur.memberCount - previous.memberCount : 0;
            const oscillation = history.length >= 3 &&
                history[0].fingerprint !== history[1].fingerprint &&
                history[1].fingerprint !== history[2].fingerprint &&
                history[0].fingerprint === history[2].fingerprint;

            let narrative: string;
            if (!previousFp) {
                narrative = `${cur.workflowName}: first observation. ${cur.memberCount} members.`;
            } else if (!changed) {
                narrative = `${cur.workflowName}: stable since last run (${cur.memberCount} members, fp unchanged).`;
            } else if (memberChange === 0) {
                silentRewriteCount++;
                narrative = `${cur.workflowName}: silent rewrite — same members, different internal topology. Inspect for unannounced refactors.`;
            } else if (memberChange > 0) {
                narrative = `${cur.workflowName}: surface expanded by ${memberChange} member${memberChange === 1 ? '' : 's'} (now ${cur.memberCount}). Verify scope creep.`;
            } else {
                narrative = `${cur.workflowName}: surface contracted by ${Math.abs(memberChange)} member${memberChange === -1 ? '' : 's'} (now ${cur.memberCount}). Verify regression / extraction is intentional.`;
            }
            if (oscillation) {
                narrative += ` Oscillating fingerprint across last runs — likely refactor instability.`;
            }
            if (changed) driftedCount++;

            out.push({
                workflowId: cur.workflowId,
                workflowName: cur.workflowName,
                currentFingerprint: cur.fingerprint,
                previousFingerprint: previousFp,
                changedSinceLastRun: changed,
                distinctFingerprintsObserved: distinct.size,
                memberCountTrend: [cur.memberCount, ...history.map(h => h.memberCount).slice(0, 9)],
                oscillationDetected: oscillation,
                memberChange,
                narrative
            });
        }

        const summary = driftedCount === 0
            ? 'No workflow drift detected vs prior runs.'
            : `${driftedCount} workflow${driftedCount === 1 ? '' : 's'} drifted since last run` +
              (silentRewriteCount > 0 ? `; ${silentRewriteCount} appear to be silent rewrites.` : '.');
        return { runId, workflows: out, summary };
    }
}
