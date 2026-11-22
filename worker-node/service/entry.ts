/** Container entry point: process one queued job, then exit (Container Apps job execution). */
import { main } from './main'

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
