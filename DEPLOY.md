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

> **Note:** Không dùng `--source` vì `NEXT_PUBLIC_*` cần truyền lúc build time qua `--build-arg`.

```bash
# Build + push image
IMAGE="asia-northeast1-docker.pkg.dev/project-63c91435-bad0-420c-859/cloud-run-source-deploy/frontend-v1:latest"
gcloud auth configure-docker asia-northeast1-docker.pkg.dev --quiet
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api-v1-956379709284.asia-northeast1.run.app \
  -t "$IMAGE" \
  ./frontend
docker push "$IMAGE"

# Deploy
gcloud run deploy frontend-v1 \
  --image "$IMAGE" \
  --region asia-northeast1 \
  --project project-63c91435-bad0-420c-859 \
  --service-account cloudrun-sa@project-63c91435-bad0-420c-859.iam.gserviceaccount.com \
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
