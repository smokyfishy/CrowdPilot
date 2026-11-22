/**
 * Cron tasks — registered into the AppCronRoom DO (worker.ts). None are needed since the
 * collaborative rooms (and their idle-expiry maintenance) were removed; the stored room data is
 * kept untouched.
 */
import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'

export const tasks: CronTask[] = []

export async function runTask(_name: string, _env: Env): Promise<void> {}
