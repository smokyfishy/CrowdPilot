/**
 * Local research-mode switch. CP_RESEARCH_YOUTUBE is read ONLY here (the local Node worker).
 * The Cloudflare app never reads it, and the container worker refuses to start when it is set
 * (worker-node/service/main.ts → assertNotResearch). See docs/AI_MIX_GENERATOR.md.
 */
export const RESEARCH_FLAG = 'CP_RESEARCH_YOUTUBE'

export function researchYouTubeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RESEARCH_FLAG] === '1'
}

/** Thrown by any cloud/container entry point if the research flag is present. */
export function assertNotResearch(env: NodeJS.ProcessEnv = process.env): void {
  if (env[RESEARCH_FLAG] !== undefined) {
    throw new Error(`${RESEARCH_FLAG} is set: research mode is local-only and must never run in the cloud worker. Refusing to start.`)
  }
}

export const RESEARCH_COMMENT = 'CrowdPilot research only — not for distribution. Private noncommercial local research; source recordings belong to their rights holders.'
