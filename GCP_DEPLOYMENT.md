# GCP Deployment Guide for CryptoPulse Backend

This guide outlines how to host the CryptoPulse FastAPI backend on Google Cloud Platform (GCP).

## Architectural Considerations for Hosting on GCP

Before deploying, there are three important architectural details to keep in mind:

### 1. SQLite Database Persistence
The backend currently uses SQLite (`cryptopulse.db`). 
* **The Challenge**: Serverless hosting like Google Cloud Run is **ephemeral**. When the container scales down to zero, restarts, or deploys a new version, any local SQLite database changes will be lost.
* **The Solutions**:
  1. **Compute Engine VM (Recommended for simplicity)**: Deploying the container on a Google Compute Engine VM with a persistent boot disk. This is the easiest way to preserve SQLite state.
  2. **Cloud Run with Volume Mounts**: You can mount a Cloud Storage bucket or a Cloud Filestore share directly to your Cloud Run container. Note that SQLite over Cloud Storage FUSE has locking limitations and may cause errors if there are highly concurrent writes.
  3. **Migration to Cloud SQL**: If you need high availability and horizontal scaling, migrate the database to PostgreSQL/MySQL via Cloud SQL (would require refactoring the database connector from `aiosqlite`).

### 2. Single-Instance / Single-Worker Constraint
* **CoinGecko Poller**: The background poller runs in-process. If you scale to multiple container instances, each instance will poll the CoinGecko API independently, potentially exceeding rate limits.
* **In-Memory WebSockets**: Connected clients are tracked in memory. Clients connected to Instance A won't receive updates broadcast on Instance B.
* **Action**: If using Cloud Run, you should restrict the maximum instances to **1** (`--max-instances=1`) to prevent multiple pollers and fragmented WebSocket states.

---

## Deployment Option A: Google Cloud Run (Serverless)

Cloud Run is the easiest way to deploy containerized applications.

### 1. Enable Required Services
Ensure you have the Google Cloud SDK installed and run:
```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com
```

### 2. Create an Artifact Registry Repository
Create a Docker repository to store your backend image:
```bash
gcloud artifacts repositories create cryptopulse-repo \
    --repository-format=docker \
    --location=us-central1 \
    --description="CryptoPulse Docker Repository"
```

### 3. Build and Submit the Image
From the root of the project, build the image using Cloud Build:
```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/YOUR_PROJECT_ID/cryptopulse-repo/backend:latest ./backend
```

### 4. Deploy to Cloud Run
Deploy the container. Crucially:
* Set `--max-instances=1` to satisfy the single-instance constraint.
* Expose the port (handled dynamically via the updated `Dockerfile` using `PORT`).

```bash
gcloud run deploy cryptopulse-backend \
    --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/cryptopulse-repo/backend:latest \
    --platform managed \
    --region us-central1 \
    --allow-unauthenticated \
    --max-instances 1 \
    --env-vars-file backend/.env
```

---

## Deployment Option B: Google Compute Engine (VM)

A VM is recommended if you want to keep the current SQLite setup without managing complex cloud storage mounts.

### 1. Create a VM Instance with Docker
You can create a VM pre-configured with Docker (Container-Optimized OS):
```bash
gcloud compute instances create-with-container cryptopulse-vm \
    --zone=us-central1-a \
    --container-image=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/cryptopulse-repo/backend:latest \
    --container-mount-host-path=host-path=/var/cryptopulse,mount-path=/app/data,mode=rw \
    --container-env-file=backend/.env \
    --tags=http-server
```
*(Make sure to update `DATABASE_URL` in your `.env` to `/app/data/cryptopulse.db` to store it on the persistent host mount).*

### 2. Configure Firewall Rule
Allow ingress traffic on port `8000` (or whatever port your backend is configured to listen on):
```bash
gcloud compute firewall-rules create allow-backend-port \
    --allow tcp:8000 \
    --target-tags=http-server
```
