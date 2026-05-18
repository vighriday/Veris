import { GraphNode } from './GraphModels';
import { RiskReport } from './RiskModels';

export enum WorkflowKind {
    Authentication = 'Authentication',
    Authorization = 'Authorization',
    Session = 'Session',
    Billing = 'Billing',
    Payments = 'Payments',
    Checkout = 'Checkout',
    Cart = 'Cart',
    Notifications = 'Notifications',
    Webhooks = 'Webhooks',
    Messaging = 'Messaging',
    Realtime = 'Realtime',
    Queue = 'Queue',
    Caching = 'Caching',
    Persistence = 'Persistence',
    Sync = 'Sync',
    Search = 'Search',
    Onboarding = 'Onboarding',
    Profile = 'Profile',
    Admin = 'Admin',
    Analytics = 'Analytics',
    AI = 'AI',
    Routing = 'Routing',
    Orchestration = 'Orchestration',
    Reporting = 'Reporting',
    Configuration = 'Configuration',
    Infrastructure = 'Infrastructure',
    Core = 'Core',
    Uncategorized = 'Uncategorized'
}

export interface WorkflowSignal {
    source: 'path' | 'import' | 'symbol' | 'framework';
    value: string;
    weight: number;
}

export interface WorkflowDomain {
    id: string;                  // stable slug (e.g. "authentication")
    name: string;                // pretty label
    kind: WorkflowKind;
    memberNodeIds: string[];
    signals: WorkflowSignal[];   // why we clustered these
    confidence: number;          // 0..100 — strength of inference
}

export interface WorkflowRiskAggregate {
    workflowId: string;
    workflowName: string;
    kind: WorkflowKind;
    memberCount: number;
    impactedCount: number;
    addedCount: number;
    removedCount: number;
    averageRisk: number;         // 0..100
    maxRisk: number;             // 0..100
    blastRadiusSum: number;
    topRisks: RiskReport[];      // up to 5
    narrative: string;           // prose summary: "Authentication workflow affected. 3 impacted nodes ..."
    runtimeRisks: string[];      // workflow-specific concerns (e.g. "stale session propagation")
}

export interface WorkflowReport {
    workflows: WorkflowDomain[];
    aggregates: WorkflowRiskAggregate[];
    unassigned: GraphNode[];     // nodes that didn't match any cluster
}
