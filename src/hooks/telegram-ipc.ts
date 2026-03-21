/**
 * telegram-ipc.ts — Send Telegram messages via IPC file.
 * Port of .claude/kaizen/hooks/lib/send-telegram-ipc.sh
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_CHAT_JID = 'tg:-5128317012';

/**
 * Send a Telegram message via IPC file.
 * Writes JSON to data/ipc/main/messages/ for the orchestrator to pick up.
 */
export function sendTelegramIpc(
  text: string,
  chatJid: string = DEFAULT_CHAT_JID,
): boolean {
  if (!text) return false;

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? '.';
  const ipcDir =
    process.env.IPC_DIR ?? path.join(projectDir, 'data/ipc/main/messages');

  try {
    fs.mkdirSync(ipcDir, { recursive: true });
  } catch {
    return false;
  }

  const filename = `notify-${Math.floor(Date.now() / 1000)}-${process.pid}-${Math.floor(Math.random() * 10000)}.json`;
  const filePath = path.join(ipcDir, filename);

  const payload = JSON.stringify({
    type: 'message',
    chatJid,
    text,
  });

  try {
    fs.writeFileSync(filePath, payload);
    return true;
  } catch {
    try {
      fs.unlinkSync(filePath);
    } catch {}
    return false;
  }
}
