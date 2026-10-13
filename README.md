# StationDesk

A web system for fuel stations. It replaces the paper sales book with a daily workflow for attendants, gives owners live oversight, and lets customers order drums, kegs and lubricants online. One installation serves many stations. Each station has its own name, logo, colours, products, staff and customers.

```
stationdesk/
  backend/    Node.js (Express) API, using a Neon PostgreSQL database
  frontend/   Next.js web app (staff, admin, customer and platform-owner screens)
```

The first thing to try after setup is the demo station (a TotalEnergies station with your price list loaded). Logins are listed under "Demo logins" below.

The zip also contains a `docker-compose.yml`. You do not need it, because the database lives on Neon. You can delete that file.

---

## 1. What you need

- Node.js 18.17 or newer (20 or 22 is fine). Check with `node -v`.
- A Neon account (neon.tech). You do **not** need to install PostgreSQL on your computer.
- (Optional) an SMTP mail account, if you want emails to go out.

## 2. Create the database on Neon

1. Log in at neon.tech and open the Neon console.
2. Create a project (or use one you already have). Pick the region closest to where your backend will run.
3. On the project dashboard, click **Connect**.
4. Copy the connection string. It looks like this:

   ```
   postgresql://USER:PASSWORD@ep-something.REGION.aws.neon.tech/neondb?sslmode=require
   ```

   Keep it ready for the next section. Treat it like a password and do not share it or put it in a public place.

If you see a switch for "Pooled connection" on the Connect screen, either choice works. If you get strange connection errors, turn pooling off and copy the string again.

Neon has a **Tables** page and a **SQL Editor** in its console, so you can look at your data there. You do not need any other database tool.

## 3. Get the backend running

```bash
cd backend
cp .env.example .env
```

On Windows Command Prompt use `copy .env.example .env` instead of `cp`.

Open the new `.env` file and change these lines. Leave the others as they are.

| Setting | What to put |
|---|---|
| `DATABASE_URL` | The Neon connection string you copied in section 2, with nothing added or removed |
| `DATABASE_SSL` | `true` (Neon requires this) |
| `JWT_SECRET` | A long random string. Make one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` and paste the result |
| `PLATFORM_OWNER_USERNAME` and `PLATFORM_OWNER_PASSWORD` | Your own login as the platform owner. Change the password. |
| `FRONTEND_URL` | Where the website will be, for example `http://localhost:3000` |
| `PUBLIC_API_URL` | Where this API will be reachable, for example `http://localhost:4000` (used for uploaded logos and photos) |

Example of the two database lines when finished:

```
DATABASE_URL=postgresql://USER:PASSWORD@ep-something.REGION.aws.neon.tech/neondb?sslmode=require
DATABASE_SSL=true
```

Then run these three commands, one after the other:

```bash
npm install
npm run setup     # creates the tables, the Help Centre guides, your platform-owner login and the demo station
npm start         # API on http://localhost:4000
```

Check it: open http://localhost:4000/api/health in your browser. You should see `{"ok":true,...}`.

To confirm the tables were created, open your project in the Neon console and look at the **Tables** page. You should see tables such as `stations`, `users`, `products` and `shifts`.

`npm run setup` is safe to run again. To skip the demo station, set `SEED_DEMO=false` in `.env` before running it.

If `npm run setup` fails:
- **"password authentication failed" or "connection refused":** the connection string was not copied exactly. Copy it again from the Neon Connect screen.
- **"SSL" or "no pg_hba.conf entry":** check that `DATABASE_SSL=true` is in `.env`.
- **A timeout the first time:** Neon may have been asleep. Run the command again.

## 4. Get the frontend running

Open a second terminal (in VS Code, use the split button on the terminal panel), then:

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev       # http://localhost:3000
```

On Windows Command Prompt use `copy .env.example .env.local`.

`.env.local` has two settings:

| Setting | What to put |
|---|---|
| `NEXT_PUBLIC_API_URL` | The backend address with `/api` at the end, for example `http://localhost:4000/api` |
| `NEXT_PUBLIC_APP_NAME` | The product name shown on the home page (default StationDesk) |

For production, use `npm run build` and then `npm start` instead of `npm run dev`. If you change `NEXT_PUBLIC_API_URL`, build again, because it is baked in at build time.

## 5. Demo logins

Open http://localhost:3000 and enter the station code **demo**, or go straight to http://localhost:3000/s/demo.

| Who | Username | Password |
|---|---|---|
| Station admin | `admin` | `Admin123!` |
| Attendant | `ada` | `Staff123!` (PIN `1234`) |
| Attendant | `musa` | `Staff123!` (PIN `4321`) |
| Customer | `customer@example.com` | `Customer123!` |
| You, the platform owner | the username and password in your `.env` | http://localhost:3000/platform/login |

Delete or change these before going live. The demo fuel prices (PMS, AGO, DPK) are placeholders. Set the real ones under Prices.

## 6. Adding a real station

1. Log in at `/platform/login`.
2. Choose **Add a station**. Give it a name, a code (it becomes the address, for example `/s/mystation`), a template, and an admin login.
3. Send the admin their address and login. They open the **setup wizard** on first login: they enter their fuels, prices, tanks, pumps and meter readings.
4. They add products under **Products**. If they send you their price list and stock count, you can log in as them (reset their password under the station's Team button) and use **Import from spreadsheet** to paste the whole list at once.
5. They add their staff under **Team**, upload a logo and pick a colour under **Settings**.

Every station is isolated. Nothing is shared between them, and nothing needs code changes per station.

An owner with several stations: under **Multi-station owners** in the platform screen, give one admin access to the other stations. They then get an **All stations** page and can switch between them.

## 7. How it works day to day

- **Shifts.** Each attendant starts their own shift (pre-filled opening meter readings, with a warning if they differ from the last close) and closes it when they are done. There is no fixed closing time. A closed shift is locked. Staff ask the admin to approve changes. The admin can close a shift for someone who left, and is alerted when a shift stays open too long.
- **Price changes.** Prices can change at any time. When a fuel price changes during a shift, attendants on that fuel enter the pump reading at that moment, so litres before and after use the right prices.
- **Fuel** is sold from pump meter readings (closing minus opening). Everything else (drums, kegs, packs, shop items) is entered as sales. Tanks are checked with dipstick litres.
- **Variance checks.** Cash that does not match what was expected, a dipstick that differs from book stock, and opening readings that do not match the last close are flagged and sent to the admin.
- **Restocks, adjustments, expenses, credit customers, suppliers and purchase orders** are all included.
- **Monthly recap.** Created automatically on the last evening of each month and emailed as a PDF. It can also be opened or regenerated for any month, as PDF or Excel.
- **Daily summary.** Sent at the hour the station chooses.
- **Offline entry.** Sales and expenses entered with no signal are saved on the phone and sent automatically when the network returns.
- **Online ordering.** Customers register (or are approved by the station), see prices after login (the admin can make prices public), and order drums, kegs and lubricants for pickup or delivery. A station can turn ordering off completely and use only the sales and stock side.
- **Help Centre** at `/s/<code>/help`, with guides for customers, staff and admin. Edit them, and add screen-recording videos later, from the platform owner screen (Help centre tab).
- **Downloads.** Sales, expenses, stock, orders, restocks, shifts, price history, credit ledger, the audit trail and a fuel-volume report as spreadsheet files.

## 8. Things left for you to fill in

- **Payment method for customer orders.** The checkout has a heading, **Payment Method**, where you will add it (`frontend/src/app/s/[slug]/(app)/shop/page.js`, search for "ADD PAYMENT METHOD UI HERE"). For now, orders default to "pay on pickup or delivery". To add more methods, add the name in `PAYMENT_METHODS` in `backend/src/routes/orders.js` and send the chosen value from the checkout.
- **SMS and WhatsApp.** Every notification already calls `backend/src/services/messaging.js`. The two functions in that file are empty. Connect your provider there. Email works as soon as you fill in the `SMTP_*` settings in `backend/.env`.

## 9. Putting it online

- Run the backend and the frontend as two services (for example two apps on Render, Railway or a VPS). Use `npm start` in each, after `npm run build` in the frontend. Your database stays on Neon.
- Use HTTPS for both. Set `FRONTEND_URL` and `PUBLIC_API_URL` to the real addresses, and `NEXT_PUBLIC_API_URL` to `https://your-api-address/api`.
- Add the same `.env` settings to your host's environment variables screen, including `DATABASE_URL` and `DATABASE_SSL=true`. Do not upload your `.env` file to a public place such as GitHub.
- Set a strong `JWT_SECRET` and change the platform owner password.
- Uploaded logos, receipts and delivery notes are saved in `UPLOAD_DIR` (default `backend/uploads`). On hosts where the disk is wiped on every deploy, attach a persistent disk and point `UPLOAD_DIR` at it.
- Background jobs (daily summary, monthly recap, open-shift alerts) run inside the backend every 10 minutes. Run **one** copy of the backend, or set `ENABLE_JOBS=false` on the extra ones.
- Neon pauses idle databases on the free plan, so the first request after a quiet spell can take a second or two. For a station using the system all day, a paid plan avoids this.
- Check how many days of history your Neon plan keeps, and do not rely on the free plan as the only copy of real sales data.

## 10. Checking it works

The check below creates and changes data, so **never run it on the database that holds real station data.**

1. In the Neon console, open your project, go to **Branches**, and create a new branch (for example `test`). Copy the connection string for that branch.
2. In `backend/.env`, temporarily put the test branch's connection string in `DATABASE_URL`.
3. Run these in the `backend` folder:

   ```bash
   npm run setup
   npm start
   ```

4. In a second terminal, from the `backend` folder:

   ```bash
   npm run test:smoke
   ```

   When it ends with `All 36 checks passed.`, everything works.
5. Put your real connection string back in `.env` and stop the server.

The test walks through logins, a shift with a mid-shift price change, offline-style duplicate protection, approvals for closed shifts, ordering, credit, reports, exports, the audit trail and separation between stations.

## 11. Notes on the sample data

- The lubricant and kegs list comes from your TotalEnergies price list effective 1 October 2026, treated as selling prices. Two names on the sheet looked like typos and were entered as "Q9000 0W30" and "Q9000 5W40". The 4-litre "Q 300" is entered as written. Check these against the real products.
- Demo stock quantities are made up. Replace them with real counts.
