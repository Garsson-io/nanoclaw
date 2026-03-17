import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    // Default queue has no coalescing delay so existing tests stay fast
    queue = new GroupQueue({ attachmentCoalesceMs: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Attachment coalescing ---
  //
  // REGRESSION GUARD: These tests protect against the following bug:
  //
  //   When a user sends a text message + document attachment as separate
  //   Telegram messages in quick succession, the document download is async.
  //   Without coalescing, the message loop starts a container for the text
  //   message before the download completes, causing the agent to reply
  //   "I don't see an attachment" — then process the document in a second turn.
  //
  // INVARIANT: With attachmentCoalesceMs > 0, a container run for a group
  //   does not start until at least `attachmentCoalesceMs` has elapsed after
  //   the first enqueueMessageCheck call, allowing concurrent downloads to
  //   complete and be stored in the DB before the container reads messages.
  //
  // SUT: GroupQueue.enqueueMessageCheck with attachmentCoalesceMs option.
  //
  // VERIFICATION: Each test uses vi.useFakeTimers() to verify the exact delay
  //   before processMessages is invoked.

  describe('attachment coalescing', () => {
    let coalescingQueue: GroupQueue;

    beforeEach(() => {
      coalescingQueue = new GroupQueue({ attachmentCoalesceMs: 1500 });
    });

    it('delays container start by attachmentCoalesceMs', async () => {
      // INVARIANT: container does not start before the coalesce window closes
      const processMessages = vi.fn(async () => true);
      coalescingQueue.setProcessMessagesFn(processMessages);

      coalescingQueue.enqueueMessageCheck('group1@g.us');

      // Must NOT start before window closes
      await vi.advanceTimersByTimeAsync(1499);
      expect(processMessages).not.toHaveBeenCalled();

      // MUST start after the coalesce delay
      await vi.advanceTimersByTimeAsync(2);
      expect(processMessages).toHaveBeenCalledTimes(1);
    });

    it('ignores duplicate enqueues during the coalesce window (only one container run)', async () => {
      // INVARIANT: N calls within the window produce exactly 1 container run
      let startCount = 0;
      const processMessages = vi.fn(async () => {
        startCount++;
        return true;
      });
      coalescingQueue.setProcessMessagesFn(processMessages);

      // Fire three rapid enqueues (simulates text + doc metadata + doc ready)
      coalescingQueue.enqueueMessageCheck('group1@g.us');
      coalescingQueue.enqueueMessageCheck('group1@g.us');
      coalescingQueue.enqueueMessageCheck('group1@g.us');

      await vi.advanceTimersByTimeAsync(2000);

      // Container started exactly once — not three times
      expect(startCount).toBe(1);
    });

    it('batches text and document that arrive within the coalesce window', async () => {
      // INVARIANT: when text arrives at T=0 and doc download completes at T=500ms,
      // both are in the DB by the time the single container run starts at T=1500ms.
      // Simulated here as two enqueue calls within the window.
      let containerRuns = 0;
      const processMessages = vi.fn(async () => {
        containerRuns++;
        return true;
      });
      coalescingQueue.setProcessMessagesFn(processMessages);

      // T=0: text message triggers enqueue
      coalescingQueue.enqueueMessageCheck('group1@g.us');

      // T=500ms: document download completes → second enqueue absorbed into window
      await vi.advanceTimersByTimeAsync(500);
      coalescingQueue.enqueueMessageCheck('group1@g.us');

      // T=1500ms: coalesce window fires — exactly one container run
      await vi.advanceTimersByTimeAsync(1100);
      expect(containerRuns).toBe(1);
    });

    it('messages piped to an active container have no coalesce delay', async () => {
      // INVARIANT: the delay only applies to the IDLE→ACTIVE transition,
      // not to messages sent to an already-running container (those go via IPC).
      let resolveFirst: () => void;
      const processMessages = vi.fn(async () => {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
        return true;
      });
      coalescingQueue.setProcessMessagesFn(processMessages);

      // First enqueue: waits for coalesce then starts
      coalescingQueue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(1501);
      expect(processMessages).toHaveBeenCalledTimes(1);

      // While active, second enqueue is queued immediately (pendingMessages flag)
      coalescingQueue.enqueueMessageCheck('group1@g.us');

      // Complete first run
      resolveFirst!();
      await vi.advanceTimersByTimeAsync(10);

      // Second run should start without an additional 1500ms delay
      expect(processMessages).toHaveBeenCalledTimes(2);
    });

    it('clears coalescePending after timer fires so next independent message gets its own window', async () => {
      // INVARIANT: the coalesce state is reset after each window so subsequent
      // independent messages also benefit from the coalescing delay.
      const processMessages = vi.fn(async () => true);
      coalescingQueue.setProcessMessagesFn(processMessages);

      // First message: timer fires, container runs and completes
      coalescingQueue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(1600);
      expect(processMessages).toHaveBeenCalledTimes(1);

      // Second independent message: gets its own coalesce delay
      coalescingQueue.enqueueMessageCheck('group1@g.us');
      await vi.advanceTimersByTimeAsync(1499);
      expect(processMessages).toHaveBeenCalledTimes(1); // window still open

      await vi.advanceTimersByTimeAsync(2);
      expect(processMessages).toHaveBeenCalledTimes(2); // window closed
    });

    it('no-op when coalesceMs is 0 — container starts immediately (existing behaviour)', async () => {
      // INVARIANT: when disabled (coalesceMs=0), enqueueMessageCheck behaves
      // exactly as before this change — starts the container synchronously.
      const noCoalesceQueue = new GroupQueue({ attachmentCoalesceMs: 0 });
      const processMessages = vi.fn(async () => true);
      noCoalesceQueue.setProcessMessagesFn(processMessages);

      noCoalesceQueue.enqueueMessageCheck('group1@g.us');

      // Should start immediately (no timer delay)
      await vi.advanceTimersByTimeAsync(0);
      expect(processMessages).toHaveBeenCalledTimes(1);
    });

    it('handles shutdown during coalesce window gracefully', async () => {
      // INVARIANT: if shutdown is called while the coalesce timer is running,
      // the timer callback is a no-op and no container starts.
      const processMessages = vi.fn(async () => true);
      coalescingQueue.setProcessMessagesFn(processMessages);

      coalescingQueue.enqueueMessageCheck('group1@g.us');

      // Shut down before the window closes
      await vi.advanceTimersByTimeAsync(500);
      await coalescingQueue.shutdown(0);

      // Let the timer fire
      await vi.advanceTimersByTimeAsync(1500);

      // Container must NOT have started
      expect(processMessages).not.toHaveBeenCalled();
    });
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
