import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, validateToolArgs, ToolValidationError } from '../../src/mcp/ToolSchemas';

/**
 * Finding D7: the low-level MCP `Server` does not validate arguments against the
 * `inputSchema` advertised in tools/list, so declared `required` fields and enums
 * were decoration. Malformed arguments reached handlers directly.
 *
 * Finding E8: agents choose tools by reading descriptions, so a description that
 * contradicts its handler causes wrong tool selection — a functional defect.
 */

describe('TOOL_DEFINITIONS', () => {
    it('advertises every tool with a name, description and schema', () => {
        expect(TOOL_DEFINITIONS.length).toBeGreaterThanOrEqual(17);
        for (const t of TOOL_DEFINITIONS) {
            expect(t.name).toBeTruthy();
            expect(t.description.length).toBeGreaterThan(40);
            expect(t.inputSchema.type).toBe('object');
        }
    });

    it('has a validator for every advertised tool', () => {
        for (const t of TOOL_DEFINITIONS) {
            // Throws only on unknown tools; an argument error here would still prove
            // the validator exists.
            try {
                validateToolArgs(t.name, {});
            } catch (e) {
                expect((e as Error).message).not.toMatch(/Unknown tool/);
            }
        }
    });

    it('declares required fields that the validator actually enforces', () => {
        for (const t of TOOL_DEFINITIONS) {
            const required: string[] = [...((t.inputSchema as any).required ?? [])];
            if (required.length === 0) continue;
            expect(() => validateToolArgs(t.name, {})).toThrow(ToolValidationError);
        }
    });

    // The descriptions previously promised behaviour the handlers did not have.
    // These assert the specific claims that were wrong.
    it('does not promise a synthetic fallback that no longer exists', () => {
        const all = TOOL_DEFINITIONS.map(t => t.description).join(' ');
        expect(all).not.toMatch(/synthetic/i);
    });

    it('describes workflow classification honestly rather than as graph clustering', () => {
        const listWorkflows = TOOL_DEFINITIONS.find(t => t.name === 'list_workflows')!;
        expect(listWorkflows.description).toMatch(/keyword vote/i);
        expect(listWorkflows.description).toMatch(/does not traverse the call graph/i);
    });

    it('names the onboarding index file the exporter actually writes', () => {
        const onboarding = TOOL_DEFINITIONS.find(t => t.name === 'export_onboarding')!;
        expect(onboarding.description).toMatch(/README\.md/);
        expect(onboarding.description).not.toMatch(/index\.md/);
    });

    it('states the real confidence_history default', () => {
        const hist = TOOL_DEFINITIONS.find(t => t.name === 'confidence_history')!;
        expect(hist.description).toMatch(/Defaults to 30/);
    });
});

describe('validateToolArgs — rejection', () => {
    it('rejects a non-object argument payload', () => {
        expect(() => validateToolArgs('analyze_repository', 'nope' as any)).toThrow(ToolValidationError);
        expect(() => validateToolArgs('analyze_repository', [] as any)).toThrow(ToolValidationError);
    });

    it('rejects an unknown tool', () => {
        expect(() => validateToolArgs('no_such_tool', {})).toThrow(/Unknown tool/);
    });

    it('rejects a non-numeric budget', () => {
        expect(() => validateToolArgs('allocate_budget', { minutes: 'fifteen' })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('allocate_budget', { minutes: 0 })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('allocate_budget', { minutes: -5 })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('allocate_budget', {})).toThrow(ToolValidationError);
    });

    it('rejects a non-array nodeIds', () => {
        expect(() => validateToolArgs('what_if_revert', { nodeIds: 'a::b' })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('what_if_revert', { nodeIds: [] })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('what_if_revert', { nodeIds: [1, 2] })).toThrow(ToolValidationError);
    });

    it('rejects a missing workflowId or nodeId', () => {
        expect(() => validateToolArgs('analyze_workflow', {})).toThrow(ToolValidationError);
        expect(() => validateToolArgs('analyze_workflow', { workflowId: '  ' })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('node_history', {})).toThrow(ToolValidationError);
    });

    it('rejects register_repo without a path', () => {
        expect(() => validateToolArgs('register_repo', { name: 'x' })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('register_repo', { name: 'x', path: '/tmp', tags: 'nope' }))
            .toThrow(ToolValidationError);
    });
});

describe('validateToolArgs — report_execution', () => {
    const valid = { nodeId: 'src/a.ts::go', tier: 'Tier 1 - Structural Verification', result: 'pass' };

    it('accepts a well-formed batch', () => {
        const out = validateToolArgs('report_execution', { executions: [valid] });
        expect((out.executions as any[]).length).toBe(1);
    });

    // Previously `tier: 'adversarial'` returned `recorded: 1` and had zero effect,
    // and an unknown `result` was stored as a row nothing could ever consume.
    it('rejects an unknown result value instead of silently storing it', () => {
        expect(() => validateToolArgs('report_execution', {
            executions: [{ ...valid, result: 'definitely-not-a-result' }]
        })).toThrow(/result must be one of/);
    });

    it('rejects an unknown trust class', () => {
        expect(() => validateToolArgs('report_execution', {
            executions: [{ ...valid, trustClass: 'totally-trustworthy' }]
        })).toThrow(/trustClass must be one of/);
    });

    it('names the offending index so a partial batch is diagnosable', () => {
        expect(() => validateToolArgs('report_execution', {
            executions: [valid, { ...valid, result: 'bogus' }]
        })).toThrow(/executions\[1\]/);
    });

    it('rejects an empty or non-array batch', () => {
        expect(() => validateToolArgs('report_execution', { executions: [] })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('report_execution', { executions: 'x' })).toThrow(ToolValidationError);
        expect(() => validateToolArgs('report_execution', {})).toThrow(ToolValidationError);
    });

    it('rejects a negative duration', () => {
        expect(() => validateToolArgs('report_execution', {
            executions: [{ ...valid, durationMs: -1 }]
        })).toThrow(/durationMs/);
    });
});

describe('validateToolArgs — acceptance', () => {
    it('accepts an omitted optional argument', () => {
        expect(validateToolArgs('analyze_pr_behavior', {})).toEqual({ baseRef: undefined });
        expect(validateToolArgs('confidence_history', {})).toEqual({ limit: undefined });
        expect(validateToolArgs('identify_unverified_behaviors', {})).toEqual({});
    });

    it('coerces and accepts a valid budget', () => {
        expect(validateToolArgs('allocate_budget', { minutes: 15 })).toEqual({ minutes: 15 });
    });

    it('accepts zero as an executedTargetsCount but rejects a negative one', () => {
        expect(validateToolArgs('identify_unverified_behaviors', { executedTargetsCount: 0 }))
            .toEqual({ executedTargetsCount: 0 });
        expect(() => validateToolArgs('identify_unverified_behaviors', { executedTargetsCount: -1 }))
            .toThrow(ToolValidationError);
    });
});
