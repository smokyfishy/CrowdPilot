#!/usr/bin/env bash
# Provision the CrowdPilot stem-separation service on Azure (idempotent-ish; run from infra/stems).
#   Resource group  crowdpilot-stems (eastus)
#   Storage         private blob container "stems" (7-day lifecycle delete) + queue "stems"; CORS for the site
#   Registry        ACR Basic, image built in the cloud (az acr build)
#   Job             Container Apps Job, event-driven by the queue (KEDA azure-queue), CPU 4 / 8 GiB,
#                   up to 12 parallel executions, 30 min timeout, scales to zero
#   Budget          $50 / month alert to the subscription owner
set -euo pipefail
RG=crowdpilot-stems
LOC=eastus
SUFFIX=${SUFFIX:-$(echo -n "$(az account show --query id -o tsv)" | md5sum | cut -c1-6)}
SA=cpstems$SUFFIX
ACR=cpstemsacr$SUFFIX
ENV=cp-stems-env
JOB=cp-stems-job

az group create -n $RG -l $LOC -o none
az storage account create -n $SA -g $RG -l $LOC --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --allow-blob-public-access false -o none
CONN=$(az storage account show-connection-string -n $SA -g $RG -o tsv)
az storage container create --name stems --connection-string "$CONN" -o none
az storage queue create --name stems --connection-string "$CONN" -o none
az storage cors clear --services b --connection-string "$CONN"
az storage cors add --services b --methods GET HEAD --origins https://crowdpilot.app.space http://localhost:5173 http://localhost:5192 http://localhost:5801 http://localhost:5802 --allowed-headers '*' --exposed-headers '*' --max-age 3600 --connection-string "$CONN"
az storage account management-policy create --account-name $SA -g $RG --policy '{"rules":[{"enabled":true,"name":"expire-stems","type":"Lifecycle","definition":{"actions":{"baseBlob":{"delete":{"daysAfterModificationGreaterThan":7}}},"filters":{"blobTypes":["blockBlob"],"prefixMatch":["stems/"]}}}]}' -o none

az acr create -n $ACR -g $RG --sku Basic --admin-enabled true -o none
az acr build -r $ACR -t cp-stems:v1 . -o none

az containerapp env create -n $ENV -g $RG -l $LOC -o none
ACR_PW=$(az acr credential show -n $ACR --query 'passwords[0].value' -o tsv)
az containerapp job create -n $JOB -g $RG --environment $ENV \
  --trigger-type Event --replica-timeout 1800 --replica-retry-limit 1 --parallelism 1 --replica-completion-count 1 \
  --min-executions 0 --max-executions 12 --polling-interval 10 \
  --image $ACR.azurecr.io/cp-stems:v1 --registry-server $ACR.azurecr.io --registry-username $ACR --registry-password "$ACR_PW" \
  --cpu 4 --memory 8Gi \
  --secrets "storage-connection=$CONN" \
  --env-vars STORAGE_CONNECTION=secretref:storage-connection STEMS_QUEUE=stems STEMS_CONTAINER=stems \
  --scale-rule-name queue --scale-rule-type azure-queue \
  --scale-rule-metadata "accountName=$SA" "queueName=stems" "queueLength=1" \
  --scale-rule-auth "connection=storage-connection" -o none

# SAS tokens for the site's server: add-only on the queue, read-only on the stem container (1 year)
EXP=$(date -u -d "+365 days" +%Y-%m-%dT%H:%MZ)
QSAS=$(az storage queue generate-sas --name stems --permissions a --expiry $EXP --connection-string "$CONN" -o tsv)
BSAS=$(az storage container generate-sas --name stems --permissions r --expiry $EXP --https-only --connection-string "$CONN" -o tsv)
echo "STEMS_QUEUE_URL=https://$SA.queue.core.windows.net/stems/messages?$QSAS"
echo "STEMS_BLOB_BASE=https://$SA.blob.core.windows.net/stems"
echo "STEMS_BLOB_SAS=$BSAS"

SUB=$(az account show --query id -o tsv)
START=$(date -u +%Y-%m-01)
az consumption budget create --budget-name crowdpilot-stems-monthly --amount 50 --category cost --time-grain monthly \
  --start-date $START --end-date 2027-12-31 --resource-group $RG -o none || echo "budget: create it in the portal (Cost Management) if the CLI refuses"
