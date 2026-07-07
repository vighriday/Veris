import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OnboardingExporter } from '../../src/engine/OnboardingExporter';
import { BehavioralGraphEngine } from '../../src/engine/BehavioralGraphEngine';
import { BehavioralDiffEngine } from '../../src/engine/BehavioralDiffEngine';
import { RiskModelingEngine } from '../../src/engine/RiskModelingEngine';
import { WorkflowClassifier } from '../../src/engine/WorkflowClassifier';
import { repo, file, fn } from './helpers';

const graphEngine = new BehavioralGraphEngine();
const tmpDirs: string[] = [];

function makeTmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veris-onboard-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) {
        const d = tmpDirs.pop()!;
        fs.rmSync(d, { recursive: true, force: true });
    }
});

function buildReport() {
    const r = repo([
        file('src/auth/login.ts', { functions: [fn('login'), fn('verifyPassword')] }),
    ]);
    const graph = graphEngine.buildGraphFromReport(r);
    const c = new WorkflowClassifier();
    const diff = new BehavioralDiffEngine().computeDiff(graphEngine.buildGraphFromReport(repo([])), graph);
    const risks = new RiskModelingEngine().assessRisk(diff, graph);
    return { workflowReport: c.report(r, graph, diff, risks), graph };
}

describe('OnboardingExporter.export', () => {
    it('writes an index and one markdown file per workflow', () => {
        const root = makeTmpRoot();
        const { workflowReport, graph } = buildReport();
        const result = new OnboardingExporter().export(root, workflowReport, graph);

        expect(fs.existsSync(result.indexPath)).toBe(true);
        expect(result.workflowPaths.length).toBe(workflowReport.workflows.length);
        for (const p of result.workflowPaths) expect(fs.existsSync(p)).toBe(true);
    });

    it('writes the onboarding files under <root>/veris-reports/onboarding', () => {
        const root = makeTmpRoot();
        const { workflowReport, graph } = buildReport();
        const result = new OnboardingExporter().export(root, workflowReport, graph);
        expect(result.outputDir).toBe(path.join(root, 'veris-reports', 'onboarding'));
    });

    it('the index links every workflow and the per-workflow file names it', () => {
        const root = makeTmpRoot();
        const { workflowReport, graph } = buildReport();
        const result = new OnboardingExporter().export(root, workflowReport, graph);

        const index = fs.readFileSync(result.indexPath, 'utf8');
        expect(index).toMatch(/# Onboarding Map/);
        for (const wf of workflowReport.workflows) {
            expect(index).toContain(`(./${wf.id}.md)`);
        }
        const first = fs.readFileSync(result.workflowPaths[0], 'utf8');
        expect(first).toMatch(/# Onboarding —/);
        expect(first).toMatch(/Where to start reading/);
    });
});
