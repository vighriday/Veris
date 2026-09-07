import { describe, it, expect } from 'vitest';
import { DriftDetector } from '../../src/engine/DriftDetector';
import { DriftReportSchema, WorkflowAggregateSchema, ALL_SCHEMAS } from '../../src/schema/PublicSchema';

/**
 * The published schemas are documentation of the tool output. Nothing validates
 * against them at runtime, which makes them easy to leave behind — `DriftReportSchema`
 * declared `currentFingerprint` as a required string while a removed workflow emits
 * null, so the schema rejected precisely the case the drift detector exists to
 * report.
 *
 * These tests compare the schema against output produced by the real engine, so the
 * two cannot drift apart silently.
 */

type JsonType = string | string[];

function declaredType(schema: any, key: string): JsonType | undefined {
    return schema?.properties?.[key]?.type;
}

function accepts(type: JsonType | undefined, actual: unknown): boolean {
    if (type === undefined) return true; // undeclared: nothing to contradict
    const types = Array.isArray(type) ? type : [type];
    if (actual === null) return types.includes('null');
    if (Array.isArray(actual)) return types.includes('array');
    if (Number.isInteger(actual)) return types.includes('integer') || types.includes('number');
    if (typeof actual === 'number') return types.includes('number');
    return types.includes(typeof actual);
}

/** Drift report for a workflow that existed in the previous run and is gone now. */
function reportWithRemoval() {
    return new DriftDetector().detect(
        'run2',
        [{ workflowId: 'auth', workflowName: 'Authentication', fingerprint: 'fp-auth', memberCount: 3 }],
        undefined,
        { previousWorkflowIds: ['auth', 'checkout'] }
    );
}

describe('DriftReportSchema matches what DriftDetector emits', () => {
    it('declares every field the detector actually returns at the top level', () => {
        const report = reportWithRemoval();
        for (const key of Object.keys(report)) {
            expect(
                Object.keys(DriftReportSchema.properties),
                `top-level key '${key}' is emitted but undeclared`
            ).toContain(key);
        }
    });

    it('requires only fields the detector always emits', () => {
        const report = reportWithRemoval() as Record<string, unknown>;
        for (const key of DriftReportSchema.required) {
            expect(report[key], `schema requires '${key}' but the detector omitted it`).not.toBeUndefined();
        }
    });

    it('accepts a removed workflow, whose currentFingerprint is null', () => {
        const report = reportWithRemoval();
        const removed = report.workflows.find(w => w.driftClass === 'removed');
        expect(removed, 'expected the detector to report a removal').toBeDefined();
        expect(removed!.currentFingerprint).toBeNull();

        const itemSchema: any = (DriftReportSchema.properties.workflows as any).items;
        expect(accepts(declaredType(itemSchema, 'currentFingerprint'), null)).toBe(true);
    });

    it('declares a type each emitted workflow value satisfies', () => {
        const report = reportWithRemoval();
        const itemSchema: any = (DriftReportSchema.properties.workflows as any).items;

        for (const workflow of report.workflows) {
            for (const [key, value] of Object.entries(workflow)) {
                expect(
                    Object.keys(itemSchema.properties),
                    `workflow key '${key}' is emitted but undeclared`
                ).toContain(key);
                expect(
                    accepts(declaredType(itemSchema, key), value),
                    `workflow key '${key}' = ${JSON.stringify(value)} violates declared type ${JSON.stringify(declaredType(itemSchema, key))}`
                ).toBe(true);
            }
            for (const key of itemSchema.required) {
                expect(
                    (workflow as Record<string, unknown>)[key],
                    `schema requires workflow.'${key}' but it was omitted`
                ).not.toBeUndefined();
            }
        }
    });

    it('constrains driftClass to the classes the detector can produce', () => {
        const itemSchema: any = (DriftReportSchema.properties.workflows as any).items;
        const declared: string[] = itemSchema.properties.driftClass.enum;
        expect(declared).toEqual(
            expect.arrayContaining(['removed', 'silent-rewrite', 'surface-contraction', 'surface-expansion', 'first-observation', 'stable'])
        );

        const report = reportWithRemoval();
        for (const w of report.workflows) {
            expect(declared, `emitted driftClass '${w.driftClass}' is not in the schema enum`).toContain(w.driftClass);
        }
    });
});

describe('ALL_SCHEMAS', () => {
    it('exposes every schema with a stable $id and a type', () => {
        const schemas = (ALL_SCHEMAS as any).schemas as Record<string, any>;
        expect(Object.keys(schemas).length).toBeGreaterThan(0);
        for (const [name, schema] of Object.entries(schemas)) {
            expect(schema.$id, `${name} has no $id`).toMatch(/^veris:\/\//);
            expect(schema.type, `${name} has no type`).toBeTruthy();
        }
    });

    it('carries a version, so a consumer can tell the shape changed', () => {
        expect(typeof (ALL_SCHEMAS as any).version).toBe('string');
    });
});

describe('WorkflowAggregateSchema matches what list_workflows emits', () => {
    // The schema required `kind`, which the handler never emitted — a published
    // contract describing a response the code did not produce. This pins the two
    // together using the same field list the handler builds.
    const EMITTED = [
        'workflowId', 'workflowName', 'kind', 'memberCount', 'impactedCount',
        'addedCount', 'removedCount', 'averageRisk', 'maxRisk', 'narrative', 'runtimeRisks'
    ];

    it('requires nothing the handler omits', () => {
        for (const key of WorkflowAggregateSchema.required) {
            expect(EMITTED, `schema requires '${key}' but list_workflows does not emit it`).toContain(key);
        }
    });

    it('declares every field the handler emits', () => {
        for (const key of EMITTED) {
            expect(
                Object.keys(WorkflowAggregateSchema.properties),
                `list_workflows emits '${key}' but the schema does not declare it`
            ).toContain(key);
        }
    });
});
