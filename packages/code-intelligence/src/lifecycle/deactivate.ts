import { closeCodeIntelligenceDb } from '../db/connection.ts'
import type { CodeIntelligenceLogger } from '../logger.ts'
import type { CodeIntelligenceRuntime } from './activate.ts'

export async function deactivateCodeIntelligence(runtime: CodeIntelligenceRuntime | undefined, logger: CodeIntelligenceLogger): Promise<void> {
  if (!runtime) return
  await runtime.fileWatcher.stop()
  await runtime.indexScheduler.stop()
  closeCodeIntelligenceDb(runtime.db)
  runtime.services.clear()
  logger.info('deactivated', { repoKey: runtime.identity.repoKey })
}
