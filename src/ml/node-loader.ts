/**
 * Node-only model loading (offline renderers / job workers): reads public/models/ml from disk.
 * Never import this from browser code (it uses node:fs).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadDjModels, type DjModels, type MlMode } from './dj-brain'

export function loadDjModelsFromDir(dir: string, mode: MlMode): Promise<DjModels> {
  const fsFetch = (async (url: string) => {
    const body = await readFile(join(dir, url.replace(/^.*\/models\/ml\//, '')), 'utf8')
    return { ok: true, json: async () => JSON.parse(body) } as Response
  }) as unknown as typeof fetch
  return loadDjModels(mode, '/models/ml/', fsFetch)
}
