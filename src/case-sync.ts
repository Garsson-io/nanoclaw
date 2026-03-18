/**
 * Case sync — backend-agnostic adapter for syncing cases to a cloud backend.
 * V1 uses GitHub Issues. The adapter can be swapped for Zammad/HubSpot later.
 *
 * SQLite remains the primary runtime store. Sync is write-through and async:
 * mutations go to SQLite first, then fire off a background sync. Failures
 * are queued for retry. Sync errors never block the case lifecycle.
 */

import type { Case } from './cases.js';
import { logger } from './logger.js';

export type CaseSyncEventType =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'done'
  | 'comment';

export interface CaseSyncEvent {
  type: CaseSyncEventType;
  case: Case;
  changes?: Partial<Case>;
  comment?: { text: string; author: string };
}

export interface SyncResult {
  success: boolean;
  issueUrl?: string;
  issueNumber?: number;
  error?: string;
}

export interface CaseSyncAdapter {
  createCase(c: Case): Promise<SyncResult>;
  updateCase(c: Case, changes: Partial<Case>): Promise<SyncResult>;
  addComment(c: Case, text: string, author: string): Promise<SyncResult>;
  closeCase(c: Case): Promise<SyncResult>;
}

interface RetryEntry {
  event: CaseSyncEvent;
  retryCount: number;
  nextRetryAt: number;
}

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 10_000; // 10 seconds

export class CaseSyncService {
  private adapter: CaseSyncAdapter | null = null;
  private retryQueue: RetryEntry[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(adapter?: CaseSyncAdapter) {
    this.adapter = adapter ?? null;
  }

  get enabled(): boolean {
    return this.adapter !== null;
  }

  start(): void {
    if (!this.adapter) return;
    this.retryTimer = setInterval(() => this.processRetryQueue(), 60_000);
    logger.info('Case sync service started');
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  async onCaseMutated(event: CaseSyncEvent): Promise<void> {
    if (!this.adapter) return;

    try {
      let result: SyncResult;

      switch (event.type) {
        case 'created':
          result = await this.adapter.createCase(event.case);
          break;
        case 'done':
          result = await this.adapter.closeCase(event.case);
          break;
        case 'comment':
          if (!event.comment) return;
          result = await this.adapter.addComment(
            event.case,
            event.comment.text,
            event.comment.author,
          );
          break;
        case 'updated':
        case 'status_changed':
          result = await this.adapter.updateCase(
            event.case,
            event.changes ?? {},
          );
          break;
        default:
          return;
      }

      if (!result.success) {
        logger.warn(
          { caseId: event.case.id, event: event.type, error: result.error },
          'Case sync failed, queuing for retry',
        );
        this.enqueueRetry(event);
      } else {
        logger.info(
          {
            caseId: event.case.id,
            event: event.type,
            issueUrl: result.issueUrl,
          },
          'Case synced to cloud',
        );
      }
    } catch (err) {
      logger.error(
        { caseId: event.case.id, event: event.type, err },
        'Case sync threw unexpectedly, queuing for retry',
      );
      this.enqueueRetry(event);
    }
  }

  private enqueueRetry(event: CaseSyncEvent): void {
    const delay = BASE_RETRY_DELAY_MS;
    this.retryQueue.push({
      event,
      retryCount: 0,
      nextRetryAt: Date.now() + delay,
    });
  }

  private async processRetryQueue(): Promise<void> {
    if (this.retryQueue.length === 0) return;

    const now = Date.now();
    const ready = this.retryQueue.filter((e) => e.nextRetryAt <= now);
    this.retryQueue = this.retryQueue.filter((e) => e.nextRetryAt > now);

    for (const entry of ready) {
      entry.retryCount++;
      if (entry.retryCount > MAX_RETRIES) {
        logger.error(
          {
            caseId: entry.event.case.id,
            event: entry.event.type,
            retries: entry.retryCount,
          },
          'Case sync retry exhausted, dropping event',
        );
        continue;
      }

      try {
        await this.onCaseMutated(entry.event);
      } catch {
        // onCaseMutated handles its own errors and re-enqueues
      }
    }
  }

  /** Visible for testing. */
  get _retryQueueLength(): number {
    return this.retryQueue.length;
  }
}
