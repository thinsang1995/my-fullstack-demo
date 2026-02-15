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

for ROLE in roles/run.developer roles/cloudsql.client roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding PROJECT_ID \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$ROLE"
done
```

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
        synchronize: config.get('NODE_ENV') !== 'production',
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

### 4.6 `.dockerignore` (`backend/.dockerignore`)

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

### 5.5 `.dockerignore` (`frontend/.dockerignore`)

```
node_modules
.next
.git
*.md
.env*
```

## Step 6: Deploy lên Cloud Run

> **Chạy từ thư mục gốc project** (chứa cả backend/ và frontend/).

### 6.1 Deploy Backend

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

### 6.2 Deploy Frontend

```bash
gcloud run deploy frontend-v1 \
  --source ./frontend \
  --region asia-northeast1 \
  --project PROJECT_ID \
  --service-account cloudrun-sa@PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars "NEXT_PUBLIC_API_URL=https://api-v1-PROJECT_NUMBER.asia-northeast1.run.app" \
  --port 3000 \
  --allow-unauthenticated \
  --quiet
```

## Step 7: GitHub Actions CI/CD (Blue-Green)

### `.github/workflows/backend-deploy.yml`

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
            --set-env-vars "DB_HOST=/cloudsql/${{ env.PROJECT_ID }}:${{ env.REGION }}:demo-db,DB_USER=demo-user,DB_NAME=demo_prod,NODE_ENV=production" \
            --set-secrets "DB_PASS=db-password:latest" \
            --port 8080 \
            --no-traffic \
            --tag green \
            --quiet

      - name: Health Check green revision
        run: |
          GREEN_URL=$(gcloud run services describe ${{ env.SERVICE_NAME }} \
            --region ${{ env.REGION }} --project ${{ env.PROJECT_ID }} \
            --format='value(status.traffic.url)' | grep green || echo "")
          if [ -n "$GREEN_URL" ]; then
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$GREEN_URL/health")
            if [ "$STATUS" != "200" ]; then echo "Health check failed!"; exit 1; fi
          fi

      - name: Migrate traffic to green
        run: |
          gcloud run services update-traffic ${{ env.SERVICE_NAME }} \
            --region ${{ env.REGION }} --project ${{ env.PROJECT_ID }} \
            --to-latest --quiet
```

### `.github/workflows/frontend-deploy.yml`

Tương tự backend, đổi:
- `SERVICE_NAME: frontend-v1`
- `--source ./frontend`
- `--port 3000`
- Bỏ `--add-cloudsql-instances` và DB env vars
- Thêm `--set-env-vars "NEXT_PUBLIC_API_URL=${{ secrets.API_URL }}"`

## Step 8: Monitoring & Logs

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

---

## Checklist

```
[ ] APIs enabled (run, sqladmin, cloudbuild, artifactregistry)
[ ] Cloud SQL instance (POSTGRES_16, db-f1-micro, enterprise)
[ ] Database + user created
[ ] Service Account cloudrun-sa + 3 roles
[ ] Compute SA + storage.admin + artifactregistry.writer
[ ] Backend: scaffold + typeorm + health endpoint + Dockerfile
[ ] Frontend: scaffold + standalone + axios + Dockerfile
[ ] Backend deployed → /health returns 200
[ ] Frontend deployed → returns 200
[ ] GitHub Actions workflows (optional)
```
