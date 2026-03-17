/**
 * Router types for the global persistent router container.
 * Phase 1: routing without rejection.
 */

export interface RouterRequest {
  type: 'route';
  requestId: string;
  messageText: string;
  senderName: string;
  groupFolder: string;
  cases: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    description: string;
    lastMessage: string | null;
    lastActivityAt: string | null;
  }>;
  rejectionHistory?: Array<{
    caseId: string;
    caseName: string;
    reason: string;
  }>;
}

export interface RouterResponse {
  requestId: string;
  decision: 'route_to_case' | 'direct_answer' | 'suggest_new';
  caseId?: string;
  caseName?: string;
  confidence: number;
  reason: string;
  directAnswer?: string;
  model?: string;
}
