/** Node ML runtime: loads the learned-DJ weights from public/models/ml on disk (no network). */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Registry } from '../../src/ml/dj-brain'
import { createMlRuntime, type MlOptions, type MlRuntime } from '../../src/mixgen/ml'
import { loadDjModelsFromDir } from '../ml/load-models'

export function nodeMlRuntime(repoRoot: string, opts: Partial<MlOptions> = {}): Promise<MlRuntime> {
  const dir = join(repoRoot, 'public', 'models', 'ml')
  return createMlRuntime(
    (mode) => loadDjModelsFromDir(dir, mode),
    async () => JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as Registry,
    opts,
  )
}
