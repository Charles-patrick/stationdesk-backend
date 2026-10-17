# Putting StationDesk online for review

This guide gets a working copy online so a colleague can open it on their phone or computer and send you corrections. It takes about 45 minutes the first time.

## The plan

You will use three services, each for the part it suits:

| Part | Service | Why |
|---|---|---|
| Database | **Neon** (you already use it) | Stores everything |
| Backend (API) | **Render** | Needs a program that stays running, saves uploaded files and runs timed jobs |
| Frontend (the website) | **Vercel** | Built for Next.js |

Why not the backend on Vercel too? Vercel runs code in short-lived pieces. The backend needs to stay running for its scheduled jobs (daily summary, monthly recap, open-shift alerts), and it saves uploaded logos and photos to a disk. Both of those work badly on Vercel. Putting only the frontend on Vercel is the normal, supported way.

When you finish you will have two web addresses:
- `https://something.vercel.app` is the one you send to your colleague.
- `https://something.onrender.com` is the backend. People never open this one.

Everything below uses free plans. Section 12 explains what the free plans cannot do.

---

## 1. Before you start

You need:
- A **GitHub** account (github.com). Free.
- A **Render** account (render.com). Sign up with GitHub.
- A **Vercel** account (vercel.com). Sign up with GitHub.
- **Git** installed on your computer. Check by running `git --version` in a terminal. If it is not found, install it from git-scm.com.
- The project unzipped, with `backend` and `frontend` folders side by side.

Keep a notes file open. You will copy several values (addresses and passwords) from one service to another.

---

## 2. Set up a separate database branch for the review

Do not mix review data with real station data. In Neon:

1. Open your project, go to **Branches**, and click **Create branch**.
2. Name it `demo` and create it.
3. With the `demo` branch selected, click **Connect** and copy the connection string. It looks like `postgresql://USER:PASSWORD@ep-something.REGION.aws.neon.tech/neondb?sslmode=require`.
4. Paste it into your notes as **DEMO DATABASE STRING**.

---

## 3. Load the database from your computer (one time)

The backend creates its tables when it starts, but the demo station, the Help Centre guides and your platform-owner login are loaded by a setup command. Render's free plan does not give you a shell, so run it from your own computer.

1. In the `backend` folder, copy the settings file:
   - Mac or Linux: `cp .env.example .env`
   - Windows Command Prompt: `copy .env.example .env`
2. Open `backend/.env` and set these lines:

   ```
   DATABASE_URL=<paste the DEMO DATABASE STRING>
   DATABASE_SSL=true
   JWT_SECRET=<a long random string, see below>
   PLATFORM_OWNER_USERNAME=owner
   PLATFORM_OWNER_PASSWORD=<choose a strong password>
   SEED_DEMO=true
   ```

   To make a random string, run this in a terminal and copy the output:

   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Save this string in your notes as **JWT SECRET**. You will use the same one on Render.
3. In a terminal, from the `backend` folder:

   ```
   npm install
   npm run setup
   ```

4. You should see "Database schema is up to date", "Platform owner ready" and "Demo station created".
5. In Neon, open the **Tables** page for the `demo` branch. You should see tables such as `stations`, `users` and `products`.

You only do this once. Never commit or share the `.env` file.

---

## 4. Put the code on GitHub

1. On github.com, click **New repository**. Name it `stationdesk`. Choose **Private**. Do not add a README or other files. Create it.
2. In a terminal, from the folder that contains `backend` and `frontend`:

   ```
   git init
   git add .
   git commit -m "StationDesk first version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/stationdesk.git
   git push -u origin main
   ```

   Replace `YOUR-USERNAME` with your GitHub name. If it asks you to sign in, follow the prompts.
3. **Check that your secrets did not upload.** Run:

   ```
   git ls-files | grep -i env
   ```

   You should only see `backend/.env.example` and `frontend/.env.example`. If you see `backend/.env` or `frontend/.env.local`, stop and tell me before continuing.

---

## 5. Deploy the backend on Render

1. On render.com, click **New +** then **Web Service**.
2. Choose **Build and deploy from a Git repository**, connect GitHub if asked, and pick your `stationdesk` repository.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `stationdesk-api` (any name is fine) |
   | Region | The one closest to your Neon region |
   | Branch | `main` |
   | **Root Directory** | `backend` |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free |

4. Scroll to **Environment Variables** and add these one by one:

   | Name | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | The DEMO DATABASE STRING |
   | `DATABASE_SSL` | `true` |
   | `JWT_SECRET` | The same JWT SECRET from section 3 |
   | `PLATFORM_OWNER_USERNAME` | `owner` |
   | `PLATFORM_OWNER_PASSWORD` | The same password as section 3 |
   | `APP_NAME` | `StationDesk` (or your product name) |
   | `FRONTEND_URL` | `http://localhost:3000` for now. You will fix it in step 7 |
   | `PUBLIC_API_URL` | `http://localhost:4000` for now. You will fix it in step 6 |
   | `ENABLE_JOBS` | `true` |
   | `SEED_DEMO` | `false` (the demo was already loaded in section 3) |

5. Click **Create Web Service**. Wait until the log says the service is live (a few minutes).
6. At the top of the page, copy the address, for example `https://stationdesk-api-abcd.onrender.com`. Save it in your notes as **BACKEND ADDRESS**.
7. Open `BACKEND ADDRESS/api/health` in a browser. You should see `{"ok":true,"name":"StationDesk"}`. The first visit can take up to a minute if the service was asleep.
8. In Render, open **Environment**, change `PUBLIC_API_URL` to your BACKEND ADDRESS (no slash at the end), and save. Render redeploys by itself.

---

## 6. Deploy the frontend on Vercel

1. On vercel.com, click **Add New** then **Project**.
2. Import your `stationdesk` repository.
3. On the configure screen, next to **Root Directory** click **Edit** and choose `frontend`. Vercel should detect **Next.js** by itself.
4. Open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `BACKEND ADDRESS/api` (for example `https://stationdesk-api-abcd.onrender.com/api`) |
   | `NEXT_PUBLIC_APP_NAME` | `StationDesk` (or your product name) |

5. Click **Deploy**. Wait for the build to finish.
6. Copy the address Vercel gives you, for example `https://stationdesk-xyz.vercel.app`. Save it in your notes as **FRONTEND ADDRESS**.

---

## 7. Connect the two (do not skip)

In production the backend only accepts requests from the address you give it.

1. In Render, open your service, then **Environment**.
2. Change `FRONTEND_URL` to your FRONTEND ADDRESS. Use the exact address with **no slash at the end**.
3. Save. Render redeploys.

If you later add a custom domain on Vercel, add it to a new variable `CORS_ORIGINS` on Render (several addresses can be separated by commas).

---

## 8. Test it yourself first

1. Wait a minute, then open your FRONTEND ADDRESS. You should see the StationDesk home page.
2. Click **Login**. On the **Owner or admin** tab, log in as `admin@demo.test` with `Admin123!`. You should see the dashboard.
3. Click **View store** at the top. This is the page customers use. Place a test order with any name and phone number.
4. Open a private window. Click **Login**, choose the **Staff** tab, and enter station code `demo`, username `ada` and password `Staff123!`. Start a shift, record a sale, and close the shift.
5. Back as admin, open Orders, and take the test order to completed.
6. Open `/platform/login` on your frontend address and log in as the platform owner.
7. Try **Sign up** from the home page with a made-up business. It should wait for your approval on the platform screen.

If something fails, see section 13.

---

## 9. Share it with your colleague

Send them:
- The FRONTEND ADDRESS.
- The demo logins from the README (admin, attendant, and the store link `/s/demo`).

Tell them:
- **The first page load can take up to a minute.** On the free plan the backend goes to sleep when nobody uses it. Open the site yourself a minute before they do.
- It works on phones. The attendant screens are designed for phones, so ask them to try those on a phone.
- Anyone with the link can open it, so do not put real station data in this copy.

A simple way to collect corrections: ask them to note, for each problem, the **screen**, **what they did**, **what they expected** and **what happened**, plus a phone screenshot if possible.

Suggested things for them to try:
1. As a customer on the store page, place an order and check it with the tracking link.
2. As an attendant, start a shift, sell some items, close the shift with a wrong cash amount, and see the flag the admin gets.
3. As admin, change a fuel price while an attendant is on shift, then see what the attendant is asked to do.
4. Cancel a sale on a closed shift and approve it as admin.
5. Check the dashboard chart and the monthly recap, and download the PDF.
6. Read the help guides for each role, and edit one under Help guides.

---

## 10. Making corrections later

Every time you fix something:

```
git add .
git commit -m "What you changed"
git push
```

Vercel and Render notice the push and redeploy by themselves. Frontend changes show in about a minute. Backend changes take a few minutes. If you change `NEXT_PUBLIC_API_URL` on Vercel, redeploy the frontend from the Vercel dashboard, because that value is fixed when it is built.

---

## 11. Updating after you have deployed once

When you get a new version of the project, or after you make corrections:

1. Replace the code in your project folder, keeping your `.env` files.
2. Run `git add .`, `git commit -m "New version"` and `git push`.
3. Vercel and Render redeploy by themselves. The backend updates the database on start, without losing data.
4. From your computer, in the `backend` folder, run `npm run setup` once against the same database. It refreshes the standard help guides.
5. On Render, you can add an optional variable `PLATFORM_OWNER_EMAIL` so you get an email when a business owner signs up.

---

## 12. What the free plans cannot do

This setup is for review, not for real station use. Render's own documentation says free web services spin down after 15 minutes without traffic, take about a minute to wake up, and lose any files written to disk when they restart. That affects this app in three ways:

- **Waking up.** The first request after a quiet period is slow.
- **Uploaded files disappear.** Station logos, product photos, expense receipts, delivery-note photos and transfer receipts are saved on the backend's disk, so they vanish on restart. Everything else is in the database and is safe.
- **Timed jobs miss their time.** The daily summary, the monthly recap and the open-shift alerts only run while the backend is awake.

Free-plan rules change, so check render.com/docs/free for the current limits.

**Before real stations use it,** do these:
1. Upgrade the Render service to a paid instance so it never sleeps.
2. Fix the uploads. Either attach a persistent disk to the Render service and set `UPLOAD_DIR` to its path, or ask me to change the backend to store files in cloud storage (for example Cloudflare R2, S3 or Vercel Blob).
3. Use a separate Neon branch (for example `production`) for real data, and check how many days of history your Neon plan keeps.
4. Change the platform-owner password and delete the demo station's logins.
5. Add your own domain on Vercel, and add it to `CORS_ORIGINS` on Render.
6. Fill in the **Payment Method** section of the checkout, and connect email (the `SMTP_*` settings on Render) and, if you want, SMS or WhatsApp.

---

## 13. If something goes wrong

| What you see | What to check |
|---|---|
| The page says "No connection" or "Failed to fetch" | The backend may be waking up. Wait a minute and refresh. If it persists, check `NEXT_PUBLIC_API_URL` on Vercel. It must end in `/api` and match your Render address exactly. |
| Browser console says "blocked by CORS" | `FRONTEND_URL` on Render is wrong. It must be your exact Vercel address with no slash at the end. |
| "We could not find that station" or the store page is empty | The setup command (section 3) was not run against the same database. Check the `DATABASE_URL` on Render points to the `demo` branch. |
| Admin login says wrong email or password | Use `admin@demo.test` and `Admin123!` on the Owner or admin tab. Attendants use the Staff tab with the station code `demo`. If you ran setup with `SEED_DEMO=false` the demo station does not exist. |
| A new station says it is waiting for approval | Expected. Approve it on the platform screen (`/platform/login`). |
| Render deploy fails with "Cannot find module" or "package.json not found" | The Root Directory was not set to `backend`. |
| Vercel build fails | The Root Directory was not set to `frontend`. |
| Backend log shows a database or SSL error | Check `DATABASE_URL` was pasted exactly and `DATABASE_SSL` is `true`. |
| A logo or photo disappeared | Expected on the free plan (see section 12). |
| You changed `NEXT_PUBLIC_API_URL` and nothing changed | Redeploy the frontend on Vercel. |

To read the backend's log: Render dashboard, your service, **Logs**. For the frontend: Vercel dashboard, your project, **Deployments**, then the latest one.
