# Deployment (free tiers, no credit card)

You need three things: a database (Neon), the API (Render), the website (Vercel).

## 1. Database: Neon
1. Create a project at neon.tech. Copy the **connection string** (it ends with `?sslmode=require`).
2. Keep it secret. This is `DATABASE_URL`.

## 2. API: Render
1. Push the repo to GitHub first (see bottom).
2. Render -> New -> Blueprint -> pick the repo (it reads `render.yaml`), or New -> Web Service with:
   - Build: `npm install --workspace backend`
   - Start: `npm run start --workspace backend`
   - Health check path: `/healthz`
3. Environment variables:
   - `DATABASE_URL` = Neon string
   - `JWT_SECRET` = 32+ random characters (Render can generate it)
   - `NODE_ENV` = `production`, `RUN_MIGRATIONS` = `true`, `NODE_VERSION` = `22`
   - `CORS_ORIGIN` = your Vercel URL (set it after step 3, then redeploy), no trailing slash
   - `REDIS_URL` = optional (free Upstash Redis works). Empty = in-memory rate limiting
   - `BOOTSTRAP_TOKEN` = optional, only if you want the HTTP bootstrap
4. Open `https://<your-api>.onrender.com/readyz`. You want `"status":"ready"`.
   (Free Render services sleep; the first request after idle takes ~30-60 s. Open it before the judges do.)

## 3. First admin (the step that got stuck before)
Easiest: run the CLI from your own laptop against the Neon database:

```bash
cd backend
DATABASE_URL='<neon string>' JWT_SECRET='any-32-char-string-for-this-local-run-xx' \
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='a-long-password-123' \
node src/createAdmin.js
```

(This connects as the Neon project owner role, so no special role/`SET ROLE` permissions are involved.)

Alternative: set `BOOTSTRAP_TOKEN` on Render, then
`curl -X POST https://<api>/api/auth/bootstrap-admin -H 'Content-Type: application/json' -H 'X-Bootstrap-Token: <token>' -d '{"email":"you@example.com","fullName":"Your Name","password":"a-long-password-123"}'`
and delete `BOOTSTRAP_TOKEN` afterwards.

## 4. Website: Vercel
1. New Project -> same repo. Set **Root Directory** to `frontend`. Framework: Vite.
2. Environment variable `VITE_API_URL` = your Render URL (no trailing slash).
3. Deploy, then put the Vercel URL into Render's `CORS_ORIGIN` and redeploy the API.
4. Open the site in an **incognito window** and log in as the admin.

## 5. GitHub
```bash
cd balancevault
git init && git add . && git commit -m "Initial BalanceVault implementation"
git branch -M main
git remote add origin https://github.com/<you>/balancevault.git
git push -u origin main
```
Make small commits as you test and fix things. The evaluators read the history.
