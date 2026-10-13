// Default Help Centre articles. After the first seed you can edit them from the platform owner screen.
// Format: blank line between paragraphs. Lines starting with "1." make a numbered list. Add a video_url later for screen recordings.

export const HELP_ARTICLES = [
  // ---------------- Customers ----------------
  { audience: 'customer', slug: 'customer-create-account', sort: 1, title: 'Create your account and log in',
    body: `You need an account to see prices and place orders.

1. Open the station's page and choose Create account.
2. Enter your name, email, phone number and a password.
3. Some stations approve new accounts first. If yours says it is waiting for approval, the station will notify you.
4. Log in with your email and password.` },
  { audience: 'customer', slug: 'customer-place-order', sort: 2, title: 'Place an order',
    body: `You can order drums, kegs, lubricants and other items the station offers online. Fuel from the pumps cannot be ordered.

1. Open Shop and find what you need. Use the search box or category tabs.
2. Choose the quantity and add it to your order.
3. Open your order, then choose Pickup or Delivery. For delivery, enter the address.
4. Pick a preferred date and time, and add a note if you need to.
5. Choose how you will pay, then place the order.

You will get a notification when the station confirms it.` },
  { audience: 'customer', slug: 'customer-track-order', sort: 3, title: 'Track an order',
    body: `Open My orders to see every order and where it stands.

Pending means the station has not looked at it yet. Confirmed means it is accepted. Ready means you can collect it, or it is on its way. Completed means it is done.

You can cancel an order yourself while it is still Pending. After it is confirmed, contact the station.` },
  { audience: 'customer', slug: 'customer-availability', sort: 4, title: 'What In stock, Low and Out of stock mean',
    body: `In stock means the station has plenty. Low means only a little is left, so order soon. Out of stock means it cannot be ordered until the station restocks.` },
  { audience: 'customer', slug: 'customer-vehicles', sort: 5, title: 'Save your vehicles',
    body: `If you order for several vehicles, save their plate numbers under Account. You can pick a vehicle when you place an order so the station knows which one it is for.` },

  // ---------------- Staff ----------------
  { audience: 'staff', slug: 'staff-start-shift', sort: 1, title: 'Start your shift',
    body: `Logging in does not start your shift. You start it yourself.

1. Log in and open Shift.
2. Tap Start shift.
3. Choose the pumps you are responsible for. A pump that is on someone else's shift cannot be chosen.
4. Check each opening reading against the number you see on the pump. It is filled in from the last closing reading.
5. If the pump shows a different number, type what the pump shows. The difference is recorded so you are not blamed for it, and the admin is told.
6. Tap Start shift to begin.` },
  { audience: 'staff', slug: 'staff-record-sales', sort: 2, title: 'Record sales of drums, packs and shop items',
    body: `Fuel sales are worked out from the pump readings, so you only record other products here.

1. Open Sales.
2. Tap the product, set the quantity and choose how it was paid: cash, transfer, POS or credit.
3. For credit, choose the customer. The sale is added to what they owe.
4. Tap Record sale.

If you made a mistake while your shift is open, cancel the sale from the list and record it again. After your shift is closed, you must ask the admin to approve a change.` },
  { audience: 'staff', slug: 'staff-no-network', sort: 3, title: 'When the network drops',
    body: `You can keep recording sales and expenses without a connection. They are saved on your phone and show as Waiting to send.

When the network returns, they are sent automatically. Do not record the same sale again. Stay on the page until the waiting count reaches zero before you close your shift.` },
  { audience: 'staff', slug: 'staff-price-change', sort: 4, title: 'When the admin changes a fuel price during your shift',
    body: `A banner appears on your Shift page asking for a pump reading.

1. Go to the pump and read the meter right now.
2. Enter the reading for each pump listed.
3. Save.

Litres sold before this reading are charged at the old price and litres after it at the new price. You cannot close your shift until the reading is saved.` },
  { audience: 'staff', slug: 'staff-restock', sort: 5, title: 'Record a restock',
    body: `1. Open Restock.
2. Choose the product. For fuel, also choose the tank that received it.
3. Enter the quantity delivered, the supplier and the waybill number.
4. For fuel, enter the dipstick reading before and after the delivery if you took them. The system warns the admin if the tank rose by less than the delivery.
5. Save. Stock goes up straight away.` },
  { audience: 'staff', slug: 'staff-close-shift', sort: 6, title: 'Close your shift',
    body: `Close your shift when you are done. There is no fixed time.

1. Open Shift and tap Close shift.
2. Enter the closing reading for each of your pumps. If a meter went past its maximum and started again, tick Meter rolled over.
3. Enter the dipstick reading for the tanks you want to check, in litres.
4. Enter the cash, transfer and POS money you are handing over.
5. Check the summary. If the difference looks wrong, go back and check your figures.
6. Tap Close shift. It is locked after that.

You can print your shift sheet from the shift page.` },
  { audience: 'staff', slug: 'staff-orders', sort: 7, title: 'Handle customer orders',
    body: `New orders appear under Orders. Open one, confirm it, mark it Ready when the items are set aside, and Complete it when the customer has collected or received it.

Completing an order takes the items out of stock and adds the sale to your shift, so start your shift first.` },
  { audience: 'staff', slug: 'staff-expenses', sort: 8, title: 'Record an expense',
    body: `Open Expenses, choose a category, enter the amount and tick Paid from the till if the money came out of the cash you are holding. Money paid from the till is taken off what you are expected to hand over.` },

  // ---------------- Admin ----------------
  { audience: 'admin', slug: 'admin-first-setup', sort: 1, title: 'First-time setup',
    body: `When you first log in, the setup wizard helps you get running in about half an hour.

1. Choose what you sell: fuel only, fuel and lubricants, fuel and shop, or everything.
2. Choose your fuels, enter today's price, and add your tanks (capacity and litres now) and pumps (current meter reading).
3. Finish. Then add your lubricants and shop items under Products. You can paste a list from a spreadsheet to add many at once.
4. Add your staff under Team.
5. Open Settings to upload your logo, set your colour and decide whether customers can order online.` },
  { audience: 'admin', slug: 'admin-products', sort: 2, title: 'Add products and import a list',
    body: `Under Products you can add one item at a time, or use Import to paste rows from a spreadsheet. Each row needs a category, name, size (optional), unit, selling price and starting stock.

Turn on Customers can order for the items you want to show on the ordering page. Fuel sold from pumps cannot be ordered online.` },
  { audience: 'admin', slug: 'admin-change-price', sort: 3, title: 'Change a price',
    body: `Open Prices, choose the product and enter the new price. It takes effect straight away and is saved in the price history.

For fuel, staff who are on shift with that pump are asked to read the meter at that moment, so old and new prices apply to the right litres. Customers see the new price at once.` },
  { audience: 'admin', slug: 'admin-tanks-pumps', sort: 4, title: 'Tanks and pumps',
    body: `Under Tanks and pumps you can add tanks, add pumps, link each pump to its tank, and see who is using which pump.

If a pump meter is replaced or reset, use Reset meter and give a reason. This sets the new starting reading so the reset is not counted as sales.` },
  { audience: 'admin', slug: 'admin-team', sort: 5, title: 'Staff accounts',
    body: `Under Team, add a person with their own username and password. Staff can also get a PIN so they can sign in quickly on a shared tablet.

Never share one login between people. Every sale and change is recorded under the name that made it. To remove someone, turn their account off. Their past records stay.` },
  { audience: 'admin', slug: 'admin-review-shifts', sort: 6, title: 'Review shifts and flags',
    body: `Shifts lists every shift with what was expected and what was handed over. A flag means something needs a look: cash that does not match, a tank dipstick that differs from the book stock, or an opening reading that did not match the last close.

Open a shift to see every sale, the pump readings and any price changes. If someone leaves without closing, use Close for them and write a note.` },
  { audience: 'admin', slug: 'admin-approvals', sort: 7, title: 'Approve changes to closed shifts',
    body: `Once a shift is closed it is locked. If staff need to cancel a sale or fix cash totals afterwards, they send a request. You will see it under Approvals with the reason. Approve to apply the change, or reject it. Either way it is recorded.` },
  { audience: 'admin', slug: 'admin-monthly-recap', sort: 8, title: 'Monthly recap',
    body: `On the last day of each month the system prepares a recap and tells you. Open Reports and choose Monthly recap to see sales, litres, best sellers, expenses, shortages and a comparison with last month. Download it as a PDF or an Excel file.

Shifts count toward the month they were closed in. A shift still open on the last day is listed as not yet closed.` },
  { audience: 'admin', slug: 'admin-ordering-settings', sort: 9, title: 'Online ordering settings',
    body: `Under Settings you can turn online ordering off if you only want to use the inventory side. You can also choose whether prices are public or only shown after login, whether new customers need your approval, and whether you deliver.` },
  { audience: 'admin', slug: 'admin-credit', sort: 10, title: 'Credit customers',
    body: `Add customers who buy on credit under Credit. When staff record a sale as credit, it is added to what that customer owes. Record each payment received. You can email a reminder to anyone who owes money and has an email address.` },
  { audience: 'admin', slug: 'admin-exports', sort: 11, title: 'Download your records',
    body: `Under Reports, use Exports to download sales, expenses, stock movements, price history, the credit ledger, the audit log and a fuel volume report as spreadsheet files for your accountant or for regulators.` },
];
