import { describe, test, expect, vi, beforeEach } from 'vitest';

import fs from 'fs';

// Mock group-folder to use predictable test paths
vi.mock('./group-folder.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    resolveGroupFolderPath: (folder: string) => `/test-groups/${folder}`,
  };
});

// Mock mount-security to return predictable mount mappings
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => [
    {
      hostPath: '/home/user/projects/prints',
      containerPath: '/workspace/extra/prints',
      readonly: true,
    },
  ]),
}));

import {
  dispatchIpcMessage,
  dispatchIpcImage,
  dispatchIpcDocument,
  resolveContainerToHostPath,
  IpcDeps,
} from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
  containerConfig: {
    additionalMounts: [
      { hostPath: '/home/user/projects/prints', containerPath: 'prints' },
    ],
  },
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'telegram_other',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: ReturnType<typeof vi.fn<IpcDeps['sendMessage']>>;
let sendImage: ReturnType<typeof vi.fn<NonNullable<IpcDeps['sendImage']>>>;
let sendDocument: ReturnType<
  typeof vi.fn<NonNullable<IpcDeps['sendDocument']>>
>;
let sendPoolMessage: ReturnType<
  typeof vi.fn<NonNullable<IpcDeps['sendPoolMessage']>>
>;

function makeDeps(
  opts: {
    withPool?: boolean;
    withImage?: boolean;
    withDocument?: boolean;
  } = {},
): IpcDeps {
  return {
    sendMessage,
    sendImage: opts.withImage ? sendImage : undefined,
    sendDocument: opts.withDocument ? sendDocument : undefined,
    sendPoolMessage: opts.withPool ? sendPoolMessage : undefined,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };
}

beforeEach(() => {
  groups = {
    'tg:111': MAIN_GROUP,
    'tg:222': OTHER_GROUP,
  };
  sendMessage = vi.fn().mockResolvedValue(undefined);
  sendImage = vi.fn().mockResolvedValue(undefined);
  sendDocument = vi.fn().mockResolvedValue(undefined);
  sendPoolMessage = vi.fn().mockResolvedValue(true);
});

describe('dispatchIpcMessage', () => {
  // INVARIANT: Messages with sender + pool configured route through sendPoolMessage
  // SUT: dispatchIpcMessage routing branch
  test('routes through pool when sender present and pool configured', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).toHaveBeenCalledWith(
      'tg:111',
      'hello',
      'Researcher',
      'telegram_main',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Messages without sender always use sendMessage
  // SUT: dispatchIpcMessage fallback path
  test('routes through sendMessage when no sender', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: When pool is not configured, sender field is ignored
  // SUT: dispatchIpcMessage without sendPoolMessage dep
  test('routes through sendMessage when pool not configured', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: Pool returning false triggers fallback to sendMessage
  // SUT: dispatchIpcMessage pool-exhausted fallback
  test('falls back to sendMessage when pool returns false', async () => {
    sendPoolMessage.mockResolvedValue(false);

    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'hello');
  });

  // INVARIANT: Non-main groups can only send to their own chatJid
  // SUT: dispatchIpcMessage authorization
  test('blocks unauthorized cross-group messages', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:111', text: 'sneaky' },
      'telegram_other', // other group trying to send to main's jid
      false,
      makeDeps(),
    );

    expect(result).toBe('unauthorized');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  // INVARIANT: Non-main groups can send to their own chatJid
  // SUT: dispatchIpcMessage authorization for self
  test('allows non-main group to send to own chatJid', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:222', text: 'allowed' },
      'telegram_other',
      false,
      makeDeps(),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:222', 'allowed');
  });

  // INVARIANT: Main group can send to any chatJid
  // SUT: dispatchIpcMessage main group privilege
  test('main group can send to any chatJid', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'tg:222', text: 'from main' },
      'telegram_main',
      true,
      makeDeps(),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:222', 'from main');
  });
  // INVARIANT: Pool is not used for non-Telegram JIDs even when sender is present
  // SUT: dispatchIpcMessage tg: prefix guard
  test('does not use pool for non-telegram JIDs', async () => {
    const result = await dispatchIpcMessage(
      { chatJid: 'wa:123@g.us', text: 'hello', sender: 'Researcher' },
      'telegram_main',
      true,
      makeDeps({ withPool: true }),
    );

    expect(result).toBe('sent');
    expect(sendPoolMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('wa:123@g.us', 'hello');
  });
});

describe('dispatchIpcImage', () => {
  // INVARIANT: Image messages are sent via sendImage when channel supports it
  test('sends image via sendImage when available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/chart.png',
        caption: 'chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).toHaveBeenCalledWith(
      'tg:111',
      '/test-groups/telegram_main/output/chart.png',
      'chart',
    );
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendImage is not available, caption is sent as text
  test('falls back to sendMessage when sendImage not available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/img.png',
        caption: 'chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'chart');

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendImage is not available and no caption, sends default text
  test('sends default text when no sendImage and no caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/img.png',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      '(Image sent but channel does not support images)',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Container paths are translated to host paths
  test('translates /workspace/group/ container paths to host paths', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/workspace/group/output/chart.png',
        caption: 'A chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    // The path should be translated from container to host
    expect(sendImage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('telegram_main/output/chart.png'),
      'A chart',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Non-main groups cannot send images to other groups
  test('blocks unauthorized cross-group image sends', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      { chatJid: 'tg:111', imagePath: '/tmp/img.png' },
      'telegram_other',
      false,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendImage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When image file doesn't exist, falls back to text with error
  test('sends fallback text when image file not found', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/missing.png',
        caption: 'A chart',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Image not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: When image file doesn't exist and no caption, user still gets feedback
  test('sends fallback text when image file not found without caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/test-groups/telegram_main/output/missing.png',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Image not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Path traversal via ../ is blocked
  test('blocks path traversal attempts', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/workspace/group/../../.env',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendImage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('dispatchIpcDocument', () => {
  // INVARIANT: Document messages are sent via sendDocument when channel supports it
  test('sends document via sendDocument when available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/report.pdf',
        filename: 'report.pdf',
        caption: 'Your report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).toHaveBeenCalledWith(
      'tg:111',
      '/test-groups/telegram_main/output/report.pdf',
      'report.pdf',
      'Your report',
    );
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendDocument is not available, caption is sent as text
  test('falls back to sendMessage when sendDocument not available', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/report.pdf',
        caption: 'Your report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith('tg:111', 'Your report');

    vi.restoreAllMocks();
  });

  // INVARIANT: When sendDocument is not available and no caption, sends default text
  test('sends default text when no sendDocument and no caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/report.pdf',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: false }),
    );

    expect(result).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      '(Document sent but channel does not support documents)',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Container paths are translated to host paths
  test('translates /workspace/group/ container paths to host paths', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/workspace/group/output/report.pdf',
        filename: 'report.pdf',
        caption: 'A report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(sendDocument).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('telegram_main/output/report.pdf'),
      'report.pdf',
      'A report',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Non-main groups cannot send documents to other groups
  test('blocks unauthorized cross-group document sends', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      { chatJid: 'tg:111', documentPath: '/tmp/doc.pdf' },
      'telegram_other',
      false,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendDocument).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: When document file doesn't exist, falls back to text with error
  test('sends fallback text when document file not found', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/missing.pdf',
        caption: 'A report',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Document not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: When document file doesn't exist and no caption, user still gets feedback
  test('sends fallback text when document file not found without caption', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/test-groups/telegram_main/output/missing.pdf',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Document not found'),
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Path traversal via ../ is blocked
  test('blocks path traversal attempts', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/workspace/group/../../.env',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendDocument).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('resolveContainerToHostPath', () => {
  // INVARIANT: /workspace/group/ paths resolve to the group folder on host
  test('resolves /workspace/group/ to group folder', () => {
    const result = resolveContainerToHostPath(
      '/workspace/group/output/chart.png',
      'telegram_main',
      groups,
    );

    expect(result).not.toBeNull();
    expect(result!.hostPath).toBe(
      '/test-groups/telegram_main/output/chart.png',
    );
    expect(result!.allowedDir).toBe('/test-groups/telegram_main');
  });

  // INVARIANT: /workspace/extra/ paths resolve to the validated additional mount host path
  test('resolves /workspace/extra/ to additional mount host path', () => {
    const result = resolveContainerToHostPath(
      '/workspace/extra/prints/reference-files/bleed/guide.pdf',
      'telegram_main',
      groups,
    );

    expect(result).not.toBeNull();
    expect(result!.hostPath).toBe(
      '/home/user/projects/prints/reference-files/bleed/guide.pdf',
    );
    expect(result!.allowedDir).toBe('/home/user/projects/prints');
  });

  // INVARIANT: /workspace/extra/ root path (no subpath) resolves correctly
  test('resolves /workspace/extra/ mount root without trailing subpath', () => {
    const result = resolveContainerToHostPath(
      '/workspace/extra/prints',
      'telegram_main',
      groups,
    );

    expect(result).not.toBeNull();
    expect(result!.hostPath).toBe('/home/user/projects/prints');
    expect(result!.allowedDir).toBe('/home/user/projects/prints');
  });

  // INVARIANT: Unknown container path prefixes are rejected
  test('returns null for unknown container path prefixes', () => {
    const result = resolveContainerToHostPath(
      '/workspace/project/src/index.ts',
      'telegram_main',
      groups,
    );

    expect(result).toBeNull();
  });

  // INVARIANT: /workspace/extra/ for group without mounts returns null
  test('returns null for /workspace/extra/ when group has no mounts', () => {
    const result = resolveContainerToHostPath(
      '/workspace/extra/prints/file.pdf',
      'telegram_other',
      groups,
    );

    expect(result).toBeNull();
  });

  // INVARIANT: Host paths within the group directory pass through
  test('passes through host paths within group directory', () => {
    const result = resolveContainerToHostPath(
      '/test-groups/telegram_main/images/photo.jpg',
      'telegram_main',
      groups,
    );

    expect(result).not.toBeNull();
    expect(result!.hostPath).toBe(
      '/test-groups/telegram_main/images/photo.jpg',
    );
    expect(result!.allowedDir).toBe('/test-groups/telegram_main');
  });

  // INVARIANT: Arbitrary absolute paths outside known mounts are rejected
  test('returns null for paths outside known mounts', () => {
    const result = resolveContainerToHostPath(
      '/etc/passwd',
      'telegram_main',
      groups,
    );

    expect(result).toBeNull();
  });
});

describe('dispatchIpcImage — /workspace/extra/ paths', () => {
  // INVARIANT: Images from additional mounts are sent successfully
  test('sends image from /workspace/extra/ mount', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/workspace/extra/prints/images/banner.jpg',
        caption: 'Banner',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('sent');
    expect(sendImage).toHaveBeenCalledWith(
      'tg:111',
      '/home/user/projects/prints/images/banner.jpg',
      'Banner',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Path traversal within extra mount is blocked
  test('blocks path traversal within /workspace/extra/ mount', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcImage(
      {
        chatJid: 'tg:111',
        imagePath: '/workspace/extra/prints/../../.env',
      },
      'telegram_main',
      true,
      makeDeps({ withImage: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendImage).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

describe('dispatchIpcDocument — /workspace/extra/ paths', () => {
  // INVARIANT: Documents from additional mounts are sent successfully
  test('sends document from /workspace/extra/ mount', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/workspace/extra/prints/reference-files/bleed/guide.pdf',
        filename: 'guide.pdf',
        caption: 'Bleed guide',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('sent');
    expect(sendDocument).toHaveBeenCalledWith(
      'tg:111',
      '/home/user/projects/prints/reference-files/bleed/guide.pdf',
      'guide.pdf',
      'Bleed guide',
    );

    vi.restoreAllMocks();
  });

  // INVARIANT: Path traversal within extra mount is blocked
  test('blocks path traversal within /workspace/extra/ mount', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:111',
        documentPath: '/workspace/extra/prints/../../etc/passwd',
      },
      'telegram_main',
      true,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendDocument).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  // INVARIANT: /workspace/extra/ from group without mounts is blocked
  test('blocks /workspace/extra/ from group without additional mounts', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await dispatchIpcDocument(
      {
        chatJid: 'tg:222',
        documentPath: '/workspace/extra/prints/file.pdf',
      },
      'telegram_other',
      false,
      makeDeps({ withDocument: true }),
    );

    expect(result).toBe('unauthorized');
    expect(sendDocument).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});
