# Stem separation service (Azure)

Demucs **htdemucs** 4-stem separation (vocals, drums, bass, other) for production mixes. The service exists because the website runs in the browser on a Cloudflare host with no compute for Demucs.

## Flow

1. The browser calls `POST /api/mixgen/stems {key}`. The request must be signed in and is rate-limited.
2. The site server re-checks the Jamendo licence: no derivatives (ND) means no stems.
3. The site server queues `{key, url}` on the Azure Storage queue `stems`, using an add-only SAS token.
4. The queue triggers a **Container Apps Job** (`cp-stems-job`):
   - It runs on 4 vCPU with 8 GiB, scales to zero and runs at most 12 executions in parallel, with a 30-minute timeout.
   - It downloads from Jamendo hosts only and runs htdemucs.
   - It measures the vocal-stem envelope, bass bleed and the aligned reconstruction residual.
   - It uploads Ogg Opus stems plus `info.json` to the private container `stems`, which deletes files after 7 days.
5. The browser polls `GET /api/mixgen/stems/:key` until the server returns the measures and read-only URLs.
   - The planner uses the vocal map.
   - The closed loop uses mono preview stems.
   - The render worker uses stems cropped to each transition window.

## Operations

| Item | Value |
|---|---|
| Resource group | `crowdpilot-stems` (eastus) |
| Budget | `crowdpilot-stems-monthly`, $50/month; alerts go to the subscription Owner role |
| Site secrets (`deepspace secrets`) | `STEMS_QUEUE_URL`, `STEMS_BLOB_BASE`, `STEMS_BLOB_SAS`. The SAS tokens expire after 1 year. |
| Provisioning | `bash provision.sh`. It prints the secrets, so never commit or keep its output. |
| Image update | `az acr build -r <acr> -t cp-stems:vN .`, then `az containerapp job update -n cp-stems-job -g crowdpilot-stems --image <acr>.azurecr.io/cp-stems:vN` |
| Turn off | `deepspace secrets delete STEMS_QUEUE_URL` (the site falls back to EQ element control), or `az group delete -n crowdpilot-stems` |
| GPU | Quota is currently 0. Request NCasT4_v3 quota in the portal, then add a GPU workload profile and rerun the job on it. |
