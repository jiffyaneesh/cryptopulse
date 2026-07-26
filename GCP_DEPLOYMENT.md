# GCP Deployment Guide for CryptoPulse Backend

This guide outlines how to host the CryptoPulse FastAPI backend on Google Cloud Platform (GCP).

## Recommended Architecture: Cloud Run + PostgreSQL (e.g., Supabase/Neon)

By default, the backend runs locally on SQLite (`cryptopulse.db`). However, since Cloud Run instances are ephemeral and scale down to zero, any database changes to a local SQLite file will be lost on container restarts.

To solve this, the backend is configured to support **both SQLite and PostgreSQL**. For GCP hosting, we highly recommend using a managed PostgreSQL database (like Supabase or Neon, which both offer generous free tiers) while keeping SQLite for local development.

### Database Connection Type Detection
The database client automatically detects which driver to use based on the `DATABASE_URL` environment variable:
* `DATABASE_URL=./cryptopulse.db` (starts with `./` or similar) $\rightarrow$ SQLite fallback.
* `DATABASE_URL=postgresql://...` or `postgres://...` $\rightarrow$ PostgreSQL.

---

## Step 1: Create a PostgreSQL Instance (Supabase or Neon)
1. Sign up on [Supabase](https://supabase.com/) or [Neon](https://neon.tech/).
2. Create a new project/database.
3. Retrieve your Connection String (URI format: `postgresql://user:password@host:5432/dbname`).

---

## Step 2: Deploy to Google Cloud Run

Cloud Run can compile and deploy your application directly from the source code without you needing to build, tag, and push Docker images manually.

### 1. Install and Initialize Google Cloud CLI
Install the Google Cloud CLI and log in:
```bash
# Verify installation
gcloud version

# Login to your Google account
gcloud auth login

# Set your active GCP project ID
gcloud config set project YOUR_PROJECT_ID
```

### 2. Enable Required Services
Enable the Cloud Build and Cloud Run APIs:
```bash
gcloud services enable run.googleapis.com database.googleapis.com
```

### 3. Deploy Directly from Source
Navigate to the `backend/` directory of the repository and deploy the service. Specify your PostgreSQL database connection details in the command (or using secret manager):

```bash
cd backend

gcloud run deploy cryptopulse-backend \
    --source . \
    --region us-central1 \
    --allow-unauthenticated \
    --max-instances 1 \
    --set-env-vars DATABASE_URL="postgresql://user:password@host:5432/dbname"
```

> [!NOTE]
> * `--source .`: Instructs Cloud Run to upload the source code to Google Cloud Build, which will automatically detect the `Dockerfile`, build the container, and deploy it.
> * `--max-instances 1`: Satisfies the single-instance constraint to stay under CoinGecko free-tier rate limits and keep WebSocket clients connected to a single in-memory state.

---

## Alternative: Keep SQLite on Google Compute Engine (VM)

If you prefer to keep using SQLite without setting up a remote PostgreSQL database, deploy the container to a VM where the filesystem is persistent.

### 1. Create a VM pre-configured with Docker (Container-Optimized OS)
```bash
gcloud compute instances create-with-container cryptopulse-vm \
    --zone=us-central1-a \
    --container-image=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/cryptopulse-repo/backend:latest \
    --container-mount-host-path=host-path=/var/cryptopulse,mount-path=/app/data,mode=rw \
    --container-env-file=backend/.env \
    --tags=http-server
```
*(Make sure to set `DATABASE_URL=/app/data/cryptopulse.db` to store it on the persistent host mount).*

### 2. Configure Firewall Rule
```bash
gcloud compute firewall-rules create allow-backend-port \
    --allow tcp:8000 \
    --target-tags=http-server
```
