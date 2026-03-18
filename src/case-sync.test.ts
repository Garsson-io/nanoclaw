import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  CaseSyncService,
  getCaseSyncService,
  setActiveSyncService,
} from './case-sync.js';
import type { CaseSyncAdapter } from './case-sync.js';
import { makeCase } from './test-helpers.js';

function makeAdapter(
  overrides: Partial<CaseSyncAdapter> = {},
): CaseSyncAdapter {
  return {
    createCase: vi.fn().mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/test/issues/1',
      issueNumber: 1,
    }),
    updateCase: vi.fn().mockResolvedValue({
      success: true,
    }),
    addComment: vi.fn().mockResolvedValue({
      success: true,
    }),
    closeCase: vi.fn().mockResolvedValue({
      success: true,
    }),
    ...overrides,
  };
}

// INVARIANT: CaseSyncService dispatches events to the configured adapter
// SUT: CaseSyncService.onCaseMutated
describe('CaseSyncService', () => {
  let adapter: CaseSyncAdapter;
  let service: CaseSyncService;

  beforeEach(() => {
    adapter = makeAdapter();
    service = new CaseSyncService(adapter);
  });

  test('enabled is true when adapter is provided', () => {
    expect(service.enabled).toBe(true);
  });

  test('enabled is false when no adapter', () => {
    const noAdapter = new CaseSyncService();
    expect(noAdapter.enabled).toBe(false);
  });

  test('dispatches created event to adapter.createCase', async () => {
    const c = makeCase();
    await service.onCaseMutated({ type: 'created', case: c });
    expect(adapter.createCase).toHaveBeenCalledWith(c);
  });

  test('dispatches done event to adapter.closeCase', async () => {
    const c = makeCase({ status: 'done', conclusion: 'Finished' });
    await service.onCaseMutated({ type: 'done', case: c });
    expect(adapter.closeCase).toHaveBeenCalledWith(c);
  });

  test('dispatches comment event to adapter.addComment', async () => {
    const c = makeCase();
    await service.onCaseMutated({
      type: 'comment',
      case: c,
      comment: { text: 'Hello', author: 'Aviad' },
    });
    expect(adapter.addComment).toHaveBeenCalledWith(c, 'Hello', 'Aviad');
  });

  test('dispatches updated event to adapter.updateCase', async () => {
    const c = makeCase();
    const changes = { status: 'blocked' as const };
    await service.onCaseMutated({
      type: 'updated',
      case: c,
      changes,
    });
    expect(adapter.updateCase).toHaveBeenCalledWith(c, changes);
  });

  test('dispatches status_changed event to adapter.updateCase', async () => {
    const c = makeCase({ status: 'blocked' });
    const changes = { status: 'blocked' as const };
    await service.onCaseMutated({
      type: 'status_changed',
      case: c,
      changes,
    });
    expect(adapter.updateCase).toHaveBeenCalledWith(c, changes);
  });

  test('skips comment event when no comment data provided', async () => {
    const c = makeCase();
    await service.onCaseMutated({ type: 'comment', case: c });
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  // INVARIANT: Sync failure never throws — it queues for retry
  // SUT: CaseSyncService.onCaseMutated with failing adapter
  test('queues for retry when adapter returns failure', async () => {
    const failAdapter = makeAdapter({
      createCase: vi.fn().mockResolvedValue({
        success: false,
        error: 'Network error',
      }),
    });
    const failService = new CaseSyncService(failAdapter);

    const c = makeCase();
    await failService.onCaseMutated({ type: 'created', case: c });

    expect(failService._retryQueueLength).toBe(1);
  });

  test('queues for retry when adapter throws', async () => {
    const throwAdapter = makeAdapter({
      createCase: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const throwService = new CaseSyncService(throwAdapter);

    const c = makeCase();
    await throwService.onCaseMutated({ type: 'created', case: c });

    expect(throwService._retryQueueLength).toBe(1);
  });

  // INVARIANT: No-op when no adapter configured
  test('does nothing when no adapter is configured', async () => {
    const noAdapter = new CaseSyncService();
    const c = makeCase();
    // Should not throw
    await noAdapter.onCaseMutated({ type: 'created', case: c });
  });
});

// INVARIANT: Module-level singleton tracks the active sync service
// SUT: getCaseSyncService, setActiveSyncService
describe('sync service singleton', () => {
  afterEach(() => {
    setActiveSyncService(null);
  });

  test('returns null when no service is set', () => {
    setActiveSyncService(null);
    expect(getCaseSyncService()).toBeNull();
  });

  test('returns the service after setActiveSyncService', () => {
    const service = new CaseSyncService(makeAdapter());
    setActiveSyncService(service);
    expect(getCaseSyncService()).toBe(service);
  });

  test('can be cleared back to null', () => {
    const service = new CaseSyncService(makeAdapter());
    setActiveSyncService(service);
    setActiveSyncService(null);
    expect(getCaseSyncService()).toBeNull();
  });
});
