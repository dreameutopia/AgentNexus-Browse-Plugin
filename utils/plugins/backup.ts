import { z } from 'zod';
import { pluginRequest } from './client';
import { LIMITS } from './contracts';
import type { SectionHandler } from '@/entrypoints/sidepanel/utils/backup/types';
const payload = z
  .object({
    archives: z
      .array(z.string().max(Math.ceil(LIMITS.archive / 3) * 4))
      .max(500),
  })
  .strict();
export function createPluginsBackupHandler(): SectionHandler {
  return {
    id: 'plugins',
    async collect() {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage)
        return null;
      const archives = await pluginRequest<string[]>('backup-export');
      return archives.length ? { archives } : null;
    },
    validate(data) {
      return payload.safeParse(data).success;
    },
    async apply(data, strategy) {
      const input = payload.parse(data),
        token = await pluginRequest<string>('backup-restore', {
          ...input,
          strategy,
        });
      return {
        rollback: async () => {
          await pluginRequest('backup-rollback', { token });
        },
      };
    },
  };
}
