# Hướng dẫn build Fullstack GCP (2 Cloud Run + Cloud SQL + GitHub CI/CD Blue-Green)

## Architecture Overview

```
https://frontend-v1-xxx.asia-northeast1.run.app  ← Next.js (Cloud Run)
       ↓ API calls
https://api-v1-xxx.asia-northeast1.run.app        ← NestJS (Cloud Run)
       ↓ Cloud SQL Proxy
Cloud SQL Postgres 16 (db-f1-micro)
       ↓ GitHub Actions CI/CD
Monorepo (backend/ + frontend/)
```

---

## Biến cần thay thế

Thay các giá trị sau cho đúng project của bạn:

| Biến | Ví dụ |
|------|-------|
| `PROJECT_ID` | `project-63c91435-bad0-420c-859` |
| `PROJECT_NUMBER` | `956379709284` (lấy từ `gcloud projects describe PROJECT_ID --format="value(projectNumber)"`) |
| `REGION` | `asia-northeast1` |
| `DB_INSTANCE` | `demo-db` |
| `DB_NAME` | `demo_prod` |
| `DB_USER` | `demo-user` |
| `DB_PASS` | `DemoPass123!` |

---

## Step 1: Enable APIs (1 phút)

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project=PROJECT_ID
```

## Step 2: Cloud SQL Postgres (5-10 phút)

> **QUAN TRỌNG:** Phải dùng `--edition=enterprise` với tier `db-f1-micro`.
> Nếu không chỉ định, GCP mặc định `ENTERPRISE_PLUS` → sẽ báo lỗi tier không hợp lệ.

```bash
# Tạo instance (mất ~5 phút)
gcloud sql instances create demo-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --edition=enterprise \
  --region=asia-northeast1 \
  --project=PROJECT_ID

# Tạo database + user
gcloud sql databases create demo_prod --instance=demo-db --project=PROJECT_ID
gcloud sql users create demo-user --instance=demo-db --password="DemoPass123!" --project=PROJECT_ID
```

**Connection string:** `/cloudsql/PROJECT_ID:asia-northeast1:demo-db`

## Step 3: Service Account + IAM Permissions (2 phút)

### 3.1 Tạo Service Account cho Cloud Run

```bash
gcloud iam service-accounts create cloudrun-sa \
  --display-name="Cloud Run Service Account" \
  --project=PROJECT_ID
```

### 3.2 Gán roles cho cloudrun-sa

```bash
SA_EMAIL="cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com"

# Roles cơ bản cho Cloud Run + Cloud SQL
for ROLE in roles/run.developer roles/cloudsql.client roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE"
done

# Roles bổ sung (cần cho CI/CD deploy từ GitHub Actions)
for ROLE in roles/storage.admin roles/artifactregistry.writer roles/cloudbuild.builds.editor roles/run.admin roles/iam.serviceAccountUser roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE"
done
```

> **Lưu ý:** Các roles bổ sung cần cho GitHub Actions CI/CD. Nếu chỉ deploy thủ công bằng `gcloud` (dùng account owner), có thể bỏ qua phần roles bổ sung.

### 3.3 Gán permissions cho default Compute SA (cần cho Cloud Build deploy)

> **QUAN TRỌNG:** Khi dùng `gcloud run deploy --source`, Cloud Build sẽ dùng default compute service account
> để build và push image. Nếu thiếu quyền sẽ bị lỗi `storage.objects.get denied` hoặc build succeed nhưng push fail.

```bash
COMPUTE_SA="PROJECT_NUMBER-compute@developer.gserviceaccount.com"

for ROLE in roles/storage.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$COMPUTE_SA" \
    --role="$ROLE"
done
```

## Step 4: Backend NestJS

### 4.1 Scaffold + Install

```bash
npx @nestjs/cli new backend --package-manager=npm --skip-git
cd backend
npm i @nestjs/typeorm typeorm pg @nestjs/config class-validator class-transformer
```

### 4.2 Config DB (`src/app.module.ts`)

```typescript
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', '/cloudsql/PROJECT_ID:asia-northeast1:demo-db'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get('DB_USER', 'demo-user'),
        password: config.get('DB_PASS', 'DemoPass123!'),
        database: config.get('DB_NAME', 'demo_prod'),
        extra: config.get('DB_HOST', '').startsWith('/cloudsql')
          ? { socketPath: config.get('DB_HOST') }
          : {},
        autoLoadEntities: true,
        synchronize: true, // OK cho demo. Production thật nên dùng TypeORM migrations
      }),
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

### 4.3 Health endpoint (`src/app.controller.ts`)

Thêm vào controller:

```typescript
@Get('health')
health() {
  return { status: 'ok', timestamp: new Date().toISOString() };
}
```

### 4.4 Main (`src/main.ts`)

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(process.env.PORT ?? 8080);
}
bootstrap();
```

### 4.5 Dockerfile (`backend/Dockerfile`)

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/main.js"]
```

### 4.6 `.gitignore` (`backend/.gitignore`)

> **QUAN TRỌNG:** NestJS CLI (`--skip-git`) không tạo `.gitignore`. Phải tạo thủ công, nếu không `node_modules` và `dist` sẽ bị commit lên repo.

```
# compiled output
/dist
/node_modules

# logs
logs
*.log
npm-debug.log*

# env files
.env*

# OS
.DS_Store

# tests
/coverage

# IDE
.idea
.vscode
*.swp
*.swo
```

### 4.7 `.dockerignore` (`backend/.dockerignore`)

```
node_modules
dist
.git
*.md
.env*
```

## Step 5: Frontend Next.js

### 5.1 Scaffold + Install

```bash
npx create-next-app@latest frontend --ts --tailwind --app --src-dir --import-alias="@/*" --eslint --no-turbopack --yes
cd frontend
npm i @tanstack/react-query axios
```

> **Lưu ý:** Cần flag `--yes` để skip các interactive prompts.

### 5.2 Config standalone output (`next.config.ts`)

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
};

export default nextConfig;
```

### 5.3 API Config (`src/lib/api.ts`)

```bash
mkdir -p src/lib
```

```typescript
import axios from "axios";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080",
  timeout: 10000,
  headers: { "Content-Type": "application/json" },
});

export default api;
```

### 5.4 Dockerfile (`frontend/Dockerfile`)

```dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
```

> **QUAN TRỌNG:** `NEXT_PUBLIC_*` env vars được Next.js inline vào JS bundle lúc **build time**, không phải runtime. Phải dùng `ARG` + `ENV` trong Dockerfile builder stage, và truyền qua `--build-arg` khi build. `--set-env-vars` trên Cloud Run chỉ set runtime env → browser sẽ không nhận được.

### 5.5 `.dockerignore` (`frontend/.dockerignore`)

```
node_modules
.next
.git
*.md
.env*
```

## Step 6: Git Init + Push to GitHub

### 6.1 Root `.gitignore`

Tạo file `.gitignore` ở thư mục gốc project:

```
node_modules
dist
.next
.env*
*.log
.claude
```

### 6.2 Init + Push

```bash
git init
git branch -M main

# Xóa nested .git từ create-next-app (nếu không dùng --skip-git)
rm -rf frontend/.git

git add .
git commit -m "Initial setup: NestJS backend + Next.js frontend on GCP Cloud Run"
git remote add origin git@github.com:YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

> **Lưu ý:** `create-next-app` tự tạo `.git` trong `frontend/`. Phải xóa trước khi commit, nếu không frontend sẽ thành git submodule.

## Step 7: Deploy lên Cloud Run

> **Chạy từ thư mục gốc project** (chứa cả backend/ và frontend/).

### 7.1 Deploy Backend

```bash
gcloud run deploy api-v1 \
  --source ./backend \
  --region asia-northeast1 \
  --project PROJECT_ID \
  --service-account cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com \
  --add-cloudsql-instances PROJECT_ID:asia-northeast1:demo-db \
  --set-env-vars "DB_HOST=/cloudsql/PROJECT_ID:asia-northeast1:demo-db,DB_USER=demo-user,DB_PASS=DemoPass123!,DB_NAME=demo_prod,NODE_ENV=production" \
  --port 8080 \
  --allow-unauthenticated \
  --quiet
```

Verify: `curl https://api-v1-PROJECT_NUMBER.asia-northeast1.run.app/health`

### 7.2 Deploy Frontend

> **QUAN TRỌNG:** Không dùng `--source` cho frontend vì `NEXT_PUBLIC_*` cần được truyền lúc **build time** qua `--build-arg`. `--source` không hỗ trợ build args.

```bash
# Build image với build-arg
IMAGE="asia-northeast1-docker.pkg.dev/PROJECT_ID/cloud-run-source-deploy/frontend-v1:latest"
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://api-v1-PROJECT_NUMBER.asia-northeast1.run.app \
  -t "$IMAGE" \
  ./frontend

# Push lên Artifact Registry (cần configure docker auth trước)
gcloud auth configure-docker asia-northeast1-docker.pkg.dev --quiet
docker push "$IMAGE"

# Deploy
gcloud run deploy frontend-v1 \
  --image "$IMAGE" \
  --region asia-northeast1 \
  --project PROJECT_ID \
  --service-account cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com \
  --port 3000 \
  --allow-unauthenticated \
  --quiet
```

## Step 8: GitHub Actions CI/CD (Blue-Green) với Workload Identity Federation

### 8.1 Tạo Workload Identity Federation (WIF) trên GCP

> WIF cho phép GitHub Actions authenticate với GCP **không cần SA key file** (an toàn hơn).

```bash
# Tạo Workload Identity Pool
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --display-name="GitHub Actions Pool" \
  --project=PROJECT_ID

# Tạo OIDC Provider cho GitHub
# Thay YOUR_USERNAME/YOUR_REPO bằng GitHub repo thực tế
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='YOUR_USERNAME/YOUR_REPO'" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --project=PROJECT_ID

# Cho phép GitHub repo impersonate cloudrun-sa
gcloud iam service-accounts add-iam-policy-binding \
  cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com \
  --project=PROJECT_ID \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/YOUR_USERNAME/YOUR_REPO"
```

> **QUAN TRỌNG:** `--attribute-condition` bắt buộc phải có, nếu không sẽ bị lỗi `INVALID_ARGUMENT`. Condition này giới hạn chỉ repo của bạn mới được authenticate.

### 8.2 Lấy WIF Provider path

```bash
gcloud iam workload-identity-pools providers describe github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --project=PROJECT_ID \
  --format="value(name)"
# Output: projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider
```

### 8.3 Set GitHub Secrets

Cần cài `gh` CLI (`brew install gh`) và đăng nhập (`gh auth login`).

```bash
# WIF Provider full path (lấy từ bước 8.2)
gh secret set WIF_PROVIDER --repo YOUR_USERNAME/YOUR_REPO \
  --body "projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider"

# Service Account email
gh secret set WIF_SERVICE_ACCOUNT --repo YOUR_USERNAME/YOUR_REPO \
  --body "cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com"

# Backend API URL (cho frontend)
gh secret set API_URL --repo YOUR_USERNAME/YOUR_REPO \
  --body "https://api-v1-PROJECT_NUMBER.REGION.run.app"
```

### 8.4 Workflow files

#### `.github/workflows/backend-deploy.yml`

```yaml
name: Backend Blue-Green Deploy

on:
  push:
    branches: [main]
    paths: ["backend/**"]
  workflow_dispatch:

env:
  PROJECT_ID: PROJECT_ID
  REGION: asia-northeast1
  SERVICE_NAME: api-v1
  SERVICE_ACCOUNT: cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Deploy new revision (no traffic)
        run: |
          gcloud run deploy ${{ env.SERVICE_NAME }} \
            --source ./backend \
            --region ${{ env.REGION }} \
            --project ${{ env.PROJECT_ID }} \
            --service-account ${{ env.SERVICE_ACCOUNT }} \
            --add-cloudsql-instances ${{ env.PROJECT_ID }}:${{ env.REGION }}:demo-db \
            --set-env-vars "DB_HOST=/cloudsql/${{ env.PROJECT_ID }}:${{ env.REGION }}:demo-db,DB_USER=demo-user,DB_PASS=DemoPass123!,DB_NAME=demo_prod,NODE_ENV=production" \
            --port 8080 \
            --no-traffic \
            --tag green \
            --quiet

      - name: Health Check green revision
        run: |
          sleep 10
          SERVICE_URL=$(gcloud run services describe ${{ env.SERVICE_NAME }} \
            --region ${{ env.REGION }} --project ${{ env.PROJECT_ID }} \
            --format='value(status.url)')
          GREEN_URL=$(echo "$SERVICE_URL" | sed 's|https://|https://green---|')
          echo "Checking: $GREEN_URL/health"
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GREEN_URL/health" || echo "000")
          echo "Health check status: $STATUS"
          if [ "$STATUS" != "200" ]; then
            echo "Health check failed!"
            exit 1
          fi

      - name: Migrate traffic to latest
        run: |
          gcloud run services update-traffic ${{ env.SERVICE_NAME }} \
            --region ${{ env.REGION }} --project ${{ env.PROJECT_ID }} \
            --to-latest --quiet
```

#### `.github/workflows/frontend-deploy.yml`

> **Khác với backend:** Frontend dùng explicit `docker build` + `push` thay vì `--source` để truyền `--build-arg NEXT_PUBLIC_API_URL` lúc build time.

```yaml
name: Frontend Blue-Green Deploy

on:
  push:
    branches: [main]
    paths: ["frontend/**"]
  workflow_dispatch:

env:
  PROJECT_ID: PROJECT_ID
  REGION: asia-northeast1
  SERVICE_NAME: frontend-v1
  SERVICE_ACCOUNT: cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
          service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev --quiet

      - name: Build and push image
        run: |
          IMAGE="${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/cloud-run-source-deploy/${{ env.SERVICE_NAME }}:${{ github.sha }}"
          docker build \
            --build-arg NEXT_PUBLIC_API_URL=${{ secrets.API_URL }} \
            -t "$IMAGE" \
            ./frontend
          docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> $GITHUB_ENV

      - name: Deploy new revision (no traffic)
        run: |
          gcloud run deploy ${{ env.SERVICE_NAME }} \
            --image ${{ env.IMAGE }} \
            --region ${{ env.REGION }} \
            --project ${{ env.PROJECT_ID }} \
            --service-account ${{ env.SERVICE_ACCOUNT }} \
            --port 3000 \
            --no-traffic \
            --tag green \
            --quiet

      - name: Health Check green revision
        run: |
          sleep 10
          SERVICE_URL=$(gcloud run services describe ${{ env.SERVICE_NAME }} \
            --region ${{ env.REGION }} --project ${{ env.PROJECT_ID }} \
            --format='value(status.url)')
          GREEN_URL=$(echo "$SERVICE_URL" | sed 's|https://|https://green---|')
          echo "Checking: $GREEN_URL"
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GREEN_URL" || echo "000")
          echo "Health check status: $STATUS"
          if [ "$STATUS" != "200" ]; then
            echo "Health check failed!"
            exit 1
          fi

      - name: Migrate traffic to latest
        run: |
          gcloud run services update-traffic ${{ env.SERVICE_NAME }} \
            --region ${{ env.REGION }} --project ${{ env.PROJECT_ID }} \
            --to-latest --quiet
```

### 8.5 Blue-Green Flow

```
1. Push code vào backend/** hoặc frontend/** trên main
2. GitHub Actions authenticate qua WIF (không cần SA key)
3. Deploy revision mới với --no-traffic --tag green
4. Health check green revision URL
5. OK → migrate 100% traffic sang revision mới
6. Fail → traffic vẫn ở revision cũ (zero-downtime)
```

Trigger thủ công: `gh workflow run "Backend Blue-Green Deploy" --repo YOUR_USERNAME/YOUR_REPO --ref main`

## Step 9: Monitoring & Logs

```bash
# Xem logs
gcloud run services logs tail api-v1 --region=asia-northeast1 --project=PROJECT_ID
gcloud run services logs tail frontend-v1 --region=asia-northeast1 --project=PROJECT_ID

# List services
gcloud run services list --region=asia-northeast1 --project=PROJECT_ID
```

---

## Troubleshooting

### Lỗi `Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition`
**Nguyên nhân:** GCP mặc định edition `ENTERPRISE_PLUS`, tier `db-f1-micro` chỉ hỗ trợ `ENTERPRISE`.
**Fix:** Thêm `--edition=enterprise` khi tạo Cloud SQL instance.

### Lỗi `storage.objects.get access denied` khi deploy
**Nguyên nhân:** Default compute service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) thiếu quyền Storage.
**Fix:** Gán `roles/storage.admin` cho compute SA (xem Step 3.3).

### Build succeed nhưng overall build FAILURE
**Nguyên nhân:** Docker image build thành công nhưng push lên Artifact Registry thất bại do thiếu quyền write.
**Fix:** Gán `roles/artifactregistry.writer` cho compute SA (xem Step 3.3).

### `create-next-app` bị treo chờ input
**Nguyên nhân:** Thiếu flag `--yes` để auto-accept defaults.
**Fix:** Thêm `--yes` vào lệnh `npx create-next-app@latest`.

### CI/CD lỗi `PERMISSION_DENIED: roles/serviceusage.serviceUsageConsumer`
**Nguyên nhân:** `cloudrun-sa` thiếu quyền `serviceusage.services.use` khi chạy `gcloud run deploy --source` từ GitHub Actions.
**Fix:** Gán `roles/serviceusage.serviceUsageConsumer` cho `cloudrun-sa` (đã bao gồm trong Step 3.2).

### CI/CD lỗi WIF `INVALID_ARGUMENT` khi tạo OIDC provider
**Nguyên nhân:** Thiếu `--attribute-condition` khi tạo provider. GCP yêu cầu bắt buộc.
**Fix:** Thêm `--attribute-condition="assertion.repository=='YOUR_USERNAME/YOUR_REPO'"`.

### Backend `node_modules` bị commit lên git
**Nguyên nhân:** NestJS CLI với `--skip-git` không tạo `.gitignore`.
**Fix:** Tạo `backend/.gitignore` thủ công (xem Step 4.6).

### Backend 500 Internal Server Error khi gọi API entity mới
**Nguyên nhân:** `synchronize: false` trong production → TypeORM không tự tạo table cho entity mới → query fail.
**Fix:** Dùng `synchronize: true` cho demo project. Production thật nên dùng TypeORM migrations (`typeorm migration:generate` + `typeorm migration:run`).

### Frontend gọi `localhost:8080` thay vì backend Cloud Run URL
**Nguyên nhân:** `NEXT_PUBLIC_*` env vars được Next.js inline vào JS bundle lúc **build time**. Dùng `--set-env-vars` trên Cloud Run chỉ set runtime env → browser nhận fallback `http://localhost:8080`.
**Fix:** Truyền `NEXT_PUBLIC_API_URL` qua Docker `--build-arg` (xem Step 5.4 Dockerfile + Step 8.4 frontend workflow). Không dùng `gcloud run deploy --source` cho frontend.

### Frontend thành git submodule
**Nguyên nhân:** `create-next-app` tự tạo `.git` trong `frontend/`.
**Fix:** `rm -rf frontend/.git` trước khi `git add`.

---

## Checklist

```
--- GCP Infrastructure ---
[ ] APIs enabled (run, sqladmin, cloudbuild, artifactregistry)
[ ] Cloud SQL instance (POSTGRES_16, db-f1-micro, --edition=enterprise)
[ ] Database + user created
[ ] Service Account cloudrun-sa + roles (run.developer, cloudsql.client, artifactregistry.reader)
[ ] cloudrun-sa CI/CD roles (storage.admin, artifactregistry.writer, cloudbuild.builds.editor, run.admin, iam.serviceAccountUser, serviceusage.serviceUsageConsumer)
[ ] Compute SA + storage.admin + artifactregistry.writer

--- Application ---
[ ] Backend: scaffold + typeorm + health endpoint + Dockerfile + .gitignore + .dockerignore
[ ] Frontend: scaffold + standalone output + axios + Dockerfile + .dockerignore
[ ] Root .gitignore created
[ ] frontend/.git removed

--- Deploy ---
[ ] Backend deployed → /health returns 200
[ ] Frontend deployed → returns 200

--- CI/CD ---
[ ] WIF Pool + OIDC Provider created (with attribute-condition)
[ ] cloudrun-sa → workloadIdentityUser binding
[ ] GitHub secrets: WIF_PROVIDER, WIF_SERVICE_ACCOUNT, API_URL
[ ] Backend workflow passed (manual dispatch test)
[ ] Frontend workflow passed (manual dispatch test)
```
