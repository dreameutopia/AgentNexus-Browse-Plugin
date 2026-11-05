import { ACTIVE_CHAT_KEY } from './runtime-protocol';

// session storage belongs to the browser session, rather than the panel page.
// Closing the panel keeps this selection; restarting the browser clears it.
export async function readActiveChat(): Promise<string> {
  const stored = await chrome.storage.session.get(ACTIVE_CHAT_KEY);
  return typeof stored[ACTIVE_CHAT_KEY] === 'string' ? stored[ACTIVE_CHAT_KEY] : '';
}

export async function rememberActiveChat(chatId: string): Promise<void> {
  await chrome.storage.session.set({ [ACTIVE_CHAT_KEY]: chatId });
}
