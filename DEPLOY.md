# Manual Deploy Commands

## Prerequisites
- `gcloud` CLI installed and authenticated
- Project: `project-63c91435-bad0-420c-859`
- Region: `asia-northeast1`

## Deploy Backend

```bash
gcloud run deploy api-v1 \
  --source ./backend \
  --region asia-northeast1 \
  --project project-63c91435-bad0-420c-859 \
  --service-account cloudrun-sa@project-63c91435-bad0-420c-859.iam.gserviceaccount.com \
  --add-cloudsql-instances project-63c91435-bad0-420c-859:asia-northeast1:demo-db \
  --set-env-vars "DB_HOST=/cloudsql/project-63c91435-bad0-420c-859:asia-northeast1:demo-db,DB_USER=demo-user,DB_PASS=DemoPass123!,DB_NAME=demo_prod,NODE_ENV=production" \
  --port 8080 \
  --allow-unauthenticated
```

## Deploy Frontend

```bash
gcloud run deploy frontend-v1 \
  --source ./frontend \
  --region asia-northeast1 \
  --project project-63c91435-bad0-420c-859 \
  --service-account cloudrun-sa@project-63c91435-bad0-420c-859.iam.gserviceaccount.com \
  --set-env-vars "NEXT_PUBLIC_API_URL=https://api-v1-<HASH>.asia-northeast1.run.app" \
  --port 3000 \
  --allow-unauthenticated
```

## Verify Deployment

```bash
# Check Cloud SQL
gcloud sql instances describe demo-db --project=project-63c91435-bad0-420c-859

# Check Service Account
gcloud iam service-accounts list --project=project-63c91435-bad0-420c-859

# Check Cloud Run services
gcloud run services list --region=asia-northeast1 --project=project-63c91435-bad0-420c-859
```
