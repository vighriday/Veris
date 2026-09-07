import { VerisState, FingerprintRecord } from '../persistence/VerisState';
import { WorkflowFingerprint } from './WorkflowFingerprint';

/**
 * Detects behavioral drift over time by comparing the current fingerprint
 * for each workflow against historical fingerprints stored in VerisState.
 *
 * "Drift" surfaces:
 *  - removal: a workflow fingerprinted in the previous run has no fingerprint now.
 *  - silent rewrites: same members, different internal edge topology.
 *  - membership expansion: surface area growing run-over-run.
 *  - membership shrink: nodes leaving a workflow (potential extraction or regression).
 *  - oscillation: fingerprint flipping back and forth (refactor instability).
 */

export type DriftClass =
    | 'removed'
    | 'silent-rewrite'
    | 'surface-contraction'
    | 'surface-expansion'
    | 'first-observation'
    | 'stable';

/**
 * Report ordering, most severe first. Removal outranks a silent rewrite because a
 * rewritten workflow can still be verified and a deleted one cannot — its absence is
 * the change most likely to have taken behaviour with it.
 */
const DRIFT_CLASS_RANK: Record<DriftClass, number> = {
    'removed': 0,
    'silent-rewrite': 1,
    'surface-contraction': 2,
    'surface-expansion': 3,
    'first-observation': 4,
    'stable': 5
};

export interface WorkflowDriftReport {
    workflowId: string;
    workflowName: string;
    /** null for a removed workflow — it has no current shape to fingerprint. */
    currentFingerprint: string | null;
    previousFingerprint: string | null;
    changedSinceLastRun: boolean;
    driftClass: DriftClass;
    distinctFingerprintsObserved: number;
    memberCountTrend: number[];   // most recent first
    oscillationDetected: boolean;
    memberChange: number;         // current - previous
    narrative: string;
}

export interface DriftReport {
    runId: string;
    /**
     * True when no prior fingerprint exists at all. A baseline run and a run with
     * nothing to report are different statements, and a consumer must not read the
     * first as an all-clear.
     */
    firstRun: boolean;
    removedCount: number;
    workflows: WorkflowDriftReport[];
    summary: string;
}

export interface DriftDetectOptions {
    /**
     * Workflow ids observed in the previous run. Callers that already know them — a
     * harness, a replay, a test — pass them here; otherwise they are read from `state`.
     */
    previousWorkflowIds?: string[];
}

const HISTORY_LIMIT = 20;
const TREND_LIMIT = 9;

export class DriftDetector {
    public detect(
        runId: string,
        current: WorkflowFingerprint[],
        state: VerisState | null,
        opts: DriftDetectOptions = {}
    ): DriftReport {
        const currentById = new Map<string, WorkflowFingerprint>();
        for (const cur of current) currentById.set(cur.workflowId, cur);

        const previousIds = opts.previousWorkflowIds ?? this.previousRunWorkflowIds(state);

        // Iterate the union of previous and current keys. Walking `current` alone left a
        // workflow that vanished between runs unexamined, so deleting one reported
        // "no drift" — the most severe drift class was the one class never emitted (B9).
        const keys: string[] = [...currentById.keys()];
        for (const id of previousIds) if (!currentById.has(id)) keys.push(id);

        const out: WorkflowDriftReport[] = [];
        let anyHistoryObserved = false;
        let driftedCount = 0;
        let silentRewriteCount = 0;
        let removedCount = 0;
        let newCount = 0;

        for (const workflowId of keys) {
            // history is newest-first per VerisState
            const history: FingerprintRecord[] = this.historyFor(state, workflowId);
            if (history.length > 0) anyHistoryObserved = true;

            const previous = history[0] || null;
            const oscillation = this.oscillates(history);
            const cur = currentById.get(workflowId);

            const entry: WorkflowDriftReport = cur
                ? this.describeSurviving(cur, previous, history, oscillation)
                : this.describeRemoved(workflowId, previous, history, oscillation);

            if (entry.oscillationDetected) {
                entry.narrative += ` Oscillating fingerprint across last runs — likely refactor instability.`;
            }
            if (entry.changedSinceLastRun) driftedCount++;
            if (entry.driftClass === 'silent-rewrite') silentRewriteCount++;
            if (entry.driftClass === 'removed') removedCount++;
            if (entry.driftClass === 'first-observation') newCount++;

            out.push(entry);
        }

        // Array.prototype.sort is stable, so same-severity workflows keep input order.
        out.sort((a, b) => DRIFT_CLASS_RANK[a.driftClass] - DRIFT_CLASS_RANK[b.driftClass]);

        const firstRun = !anyHistoryObserved && previousIds.length === 0;
        return {
            runId,
            firstRun,
            removedCount,
            workflows: out,
            summary: this.summarize(firstRun, current.length, driftedCount, removedCount, silentRewriteCount, newCount)
        };
    }

    private describeSurviving(
        cur: WorkflowFingerprint,
        previous: FingerprintRecord | null,
        history: FingerprintRecord[],
        oscillation: boolean
    ): WorkflowDriftReport {
        const previousFp = previous ? previous.fingerprint : null;
        const changed = previousFp !== null && previousFp !== cur.fingerprint;
        const memberChange = previous ? cur.memberCount - previous.memberCount : 0;
        const distinct = new Set(history.map(h => h.fingerprint));
        distinct.add(cur.fingerprint);

        let driftClass: DriftClass;
        let narrative: string;
        if (!previousFp) {
            driftClass = 'first-observation';
            narrative = `${cur.workflowName}: first observation. ${cur.memberCount} members.`;
        } else if (!changed) {
            driftClass = 'stable';
            narrative = `${cur.workflowName}: stable since last run (${cur.memberCount} members, fp unchanged).`;
        } else if (memberChange === 0) {
            driftClass = 'silent-rewrite';
            narrative = `${cur.workflowName}: silent rewrite — same members, different internal topology. Inspect for unannounced refactors.`;
        } else if (memberChange > 0) {
            driftClass = 'surface-expansion';
            narrative = `${cur.workflowName}: surface expanded by ${memberChange} member${memberChange === 1 ? '' : 's'} (now ${cur.memberCount}). Verify scope creep.`;
        } else {
            driftClass = 'surface-contraction';
            narrative = `${cur.workflowName}: surface contracted by ${Math.abs(memberChange)} member${memberChange === -1 ? '' : 's'} (now ${cur.memberCount}). Verify regression / extraction is intentional.`;
        }

        return {
            workflowId: cur.workflowId,
            workflowName: cur.workflowName,
            currentFingerprint: cur.fingerprint,
            previousFingerprint: previousFp,
            changedSinceLastRun: changed,
            driftClass,
            distinctFingerprintsObserved: distinct.size,
            memberCountTrend: [cur.memberCount, ...history.map(h => h.memberCount).slice(0, TREND_LIMIT)],
            oscillationDetected: oscillation,
            memberChange,
            narrative
        };
    }

    private describeRemoved(
        workflowId: string,
        previous: FingerprintRecord | null,
        history: FingerprintRecord[],
        oscillation: boolean
    ): WorkflowDriftReport {
        // The fingerprints table stores no display name, so the id is the only label
        // available for a workflow that no longer appears in the classification.
        const lastKnownMembers = previous ? previous.memberCount : 0;
        const wasSize = previous ? ` (was ${lastKnownMembers} members)` : '';
        const narrative =
            `${workflowId}: REMOVED — fingerprinted in the previous run, absent now${wasSize}. ` +
            `Confirm the behaviour was deleted deliberately and not silently lost; nothing verifies a workflow that no longer classifies.`;

        return {
            workflowId,
            workflowName: workflowId,
            currentFingerprint: null,
            previousFingerprint: previous ? previous.fingerprint : null,
            changedSinceLastRun: true,
            driftClass: 'removed',
            distinctFingerprintsObserved: new Set(history.map(h => h.fingerprint)).size,
            memberCountTrend: [0, ...history.map(h => h.memberCount).slice(0, TREND_LIMIT)],
            oscillationDetected: oscillation,
            memberChange: -lastKnownMembers,
            narrative
        };
    }

    /** A,B,A across the three most recent recorded runs. */
    private oscillates(history: FingerprintRecord[]): boolean {
        return history.length >= 3 &&
            history[0].fingerprint !== history[1].fingerprint &&
            history[1].fingerprint !== history[2].fingerprint &&
            history[0].fingerprint === history[2].fingerprint;
    }

    private summarize(
        firstRun: boolean,
        currentCount: number,
        driftedCount: number,
        removedCount: number,
        silentRewriteCount: number,
        newCount: number
    ): string {
        if (firstRun) {
            // A baseline is not an all-clear: there is nothing yet to have drifted from.
            return currentCount === 0
                ? 'First run on record — no workflows classified, nothing to baseline.'
                : `First run on record — no prior fingerprints to compare against. Baseline captured for ${currentCount} workflow${currentCount === 1 ? '' : 's'}.`;
        }
        if (driftedCount === 0) {
            return newCount === 0
                ? 'No workflow drift detected vs prior runs.'
                : `No drift in previously tracked workflows; ${newCount} newly observed workflow${newCount === 1 ? '' : 's'} baselined.`;
        }
        const parts: string[] = [];
        if (removedCount > 0) parts.push(`${removedCount} removed`);
        if (silentRewriteCount > 0) parts.push(`${silentRewriteCount} silent rewrite${silentRewriteCount === 1 ? '' : 's'}`);
        if (newCount > 0) parts.push(`${newCount} newly observed`);
        return `${driftedCount} workflow${driftedCount === 1 ? '' : 's'} drifted since last run` +
               (parts.length > 0 ? ` (${parts.join(', ')}).` : '.');
    }

    private historyFor(state: VerisState | null, workflowId: string): FingerprintRecord[] {
        if (!state || !state.enabled || typeof state.fingerprintHistory !== 'function') return [];
        return state.fingerprintHistory(workflowId, HISTORY_LIMIT);
    }

    /**
     * Workflow ids that carry a fingerprint from the most recent recorded run.
     *
     * Scoped to that one run rather than to every id ever fingerprinted: a workflow
     * deleted twenty runs ago is old news, and re-announcing it as "removed" on every
     * subsequent run would bury the deletion that actually just happened. Because the
     * current run's fingerprints are persisted after drift detection, the newest
     * recorded run here is the previous one.
     *
     * The typeof guards keep drift reporting working against a state layer that
     * predates these queries — a missing query degrades to "no removals detected",
     * never a throw inside a reporting path.
     */
    private previousRunWorkflowIds(state: VerisState | null): string[] {
        if (!state || !state.enabled) return [];
        if (typeof state.knownWorkflowIds !== 'function' || typeof state.latestFingerprintFor !== 'function') return [];

        const latestPerWorkflow = new Map<string, FingerprintRecord>();
        let latestRunId: string | null = null;
        let latestTs = '';
        for (const id of state.knownWorkflowIds()) {
            const rec = state.latestFingerprintFor(id);
            if (!rec) continue;
            latestPerWorkflow.set(id, rec);
            if (rec.ts > latestTs) {
                latestTs = rec.ts;
                latestRunId = rec.runId;
            }
        }
        if (latestRunId === null) return [];

        const ids: string[] = [];
        for (const [id, rec] of latestPerWorkflow) {
            if (rec.runId === latestRunId) ids.push(id);
        }
        return ids;
    }
}
