/**
 * Cron tasks — registered into the AppCronRoom DO (worker.ts). The schedule
 * arms on the app's first request (armCronRoom middleware).
 */
import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { runMaintenance } from './server/maintenance'
import { appScope, createRoomTools, roomScope } from './server/room-tools'

export const tasks: CronTask[] = [{ name: 'maintenance', intervalMinutes: 60 }]

export async function runTask(name: string, env: Env): Promise<void> {
  if (name !== 'maintenance') return
  const result = await runMaintenance(
    createRoomTools(env, appScope(env), env.OWNER_USER_ID),
    (roomId) => createRoomTools(env, roomScope(roomId), env.OWNER_USER_ID),
    Date.now(),
  )
  console.info(`[cron] maintenance expired=${result.expired} pruned=${result.pruned}`)
}
