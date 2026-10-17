// Default Help Centre guides. Every new station gets its own copy, which its admin can edit, delete or add to.
// Format: blank line = new paragraph. Lines starting "1." make a numbered list. Add a video_url later for screen recordings.

export const HELP_ARTICLES = [
  // ---------------- Customers ----------------
  { audience: 'customer', slug: 'customer-place-order', sort: 1, title: 'Place an order',
    body: `You do not need an account. Just choose what you want and fill in your details.

1. Find what you need. Use the search box or the category buttons.
2. Tap Add to order, and set the quantity.
3. Tap View order at the bottom of the screen.
4. Enter your name and a phone number the station can call. An email address is optional, but we will send updates to it if you add one.
5. Choose pickup or delivery. For delivery, enter the address.
6. Pick a preferred date and time if you like, then place the order.

Fuel from the pumps is bought at the station and cannot be ordered here.` },
  { audience: 'customer', slug: 'customer-track-order', sort: 2, title: 'Check on your order',
    body: `After you order, you get an order number and a tracking link. Save the link, or take a screenshot of the page. If you gave an email address, we also send it there.

Pending means the station has not looked at it yet. Confirmed means it is accepted. Ready means you can collect it, or it is on its way. Completed means it is done.

Lost your link? Open Track an order on the store page and enter your order number and the phone number you used.` },
  { audience: 'customer', slug: 'customer-cancel', sort: 3, title: 'Cancel an order or send your transfer receipt',
    body: `Open your tracking link. While the order is still Pending you will see a Cancel button. After the station confirms it, please call them instead.

If you pay by bank transfer, you can upload a photo of your receipt on the same page so the station can confirm your payment.` },
  { audience: 'customer', slug: 'customer-availability', sort: 4, title: 'What In stock, Low and Out of stock mean',
    body: `In stock means the station has plenty. Low means only a little is left, so order soon. Out of stock means it cannot be ordered until the station restocks.` },
  { audience: 'customer', slug: 'customer-credit', sort: 5, title: 'Buying on credit',
    body: `If you would like to buy on credit, please contact the station directly. Online orders are paid on pickup or delivery, or by bank transfer.` },

  // ---------------- Staff ----------------
  { audience: 'staff', slug: 'staff-login', sort: 1, title: 'Log in',
    body: `Open the website and tap Login, then choose the Staff tab.

1. Enter your station code. Your manager will tell you what it is. This phone remembers it after the first time.
2. Enter your username.
3. Enter your password, or your PIN if you have one.` },
  { audience: 'staff', slug: 'staff-start-shift', sort: 2, title: 'Start your shift',
    body: `Logging in does not start your shift. You start it yourself.

1. Log in and open Shift.
2. Tap Start shift.
3. Choose the pumps you are responsible for. A pump that is on someone else's shift cannot be chosen.
4. Check each opening reading against the number you see on the pump. It is filled in from the last closing reading.
5. If the pump shows a different number, type what the pump shows. The difference is recorded so you are not blamed for it, and the admin is told.
6. Tap Start shift to begin.` },
  { audience: 'staff', slug: 'staff-record-sales', sort: 3, title: 'Record sales of drums, packs and shop items',
    body: `Fuel sales are worked out from the pump readings, so you only record other products here.

1. Open Sales.
2. Tap the product, set the quantity and choose how it was paid: cash, transfer or POS.
3. Tap Record sale.

If you made a mistake while your shift is open, cancel the sale from the list and record it again. After your shift is closed, you must ask the admin to approve a change.` },
  { audience: 'staff', slug: 'staff-no-network', sort: 4, title: 'When the network drops',
    body: `You can keep recording sales and expenses without a connection. They are saved on your phone and show as Waiting to send.

When the network returns, they are sent automatically. Do not record the same sale again. Stay on the page until the waiting count reaches zero before you close your shift.` },
  { audience: 'staff', slug: 'staff-price-change', sort: 5, title: 'When the admin changes a fuel price during your shift',
    body: `A banner appears on your Shift page asking for a pump reading.

1. Go to the pump and read the meter right now.
2. Enter the reading for each pump listed.
3. Save.

Litres sold before this reading are charged at the old price and litres after it at the new price. You cannot close your shift until the reading is saved.` },
  { audience: 'staff', slug: 'staff-restock', sort: 6, title: 'Record a restock',
    body: `1. Open Restock.
2. Choose the product. For fuel, also choose the tank that received it.
3. Enter the quantity delivered, the supplier and the waybill number.
4. For fuel, enter the dipstick reading before and after the delivery if you took them. The system warns the admin if the tank rose by less than the delivery.
5. Save. Stock goes up straight away.` },
  { audience: 'staff', slug: 'staff-close-shift', sort: 7, title: 'Close your shift',
    body: `Close your shift when you are done. There is no fixed time.

1. Open Shift and tap Close shift.
2. Enter the closing reading for each of your pumps. If a meter went past its maximum and started again, tick Meter rolled over.
3. Enter the dipstick reading for the tanks you want to check, in litres.
4. Enter the cash, transfer and POS money you are handing over.
5. Check the summary. If the difference looks wrong, go back and check your figures.
6. Tap Close shift. It is locked after that.

You can print your shift sheet from the shift page.` },
  { audience: 'staff', slug: 'staff-orders', sort: 8, title: 'Handle customer orders',
    body: `New orders appear under Orders. Open one, confirm it, mark it Ready when the items are set aside, and Complete it when the customer has collected or received it. Call the customer on the phone number shown if you need to.

Completing an order takes the items out of stock and adds the sale to your shift, so start your shift first.` },
  { audience: 'staff', slug: 'staff-expenses', sort: 9, title: 'Record an expense',
    body: `Open Expenses, choose a category, enter the amount and tick Paid from the till if the money came out of the cash you are holding. Money paid from the till is taken off what you are expected to hand over.` },

  // ---------------- Admin ----------------
  { audience: 'admin', slug: 'admin-first-setup', sort: 1, title: 'First-time setup',
    body: `When you first log in, the setup wizard helps you get running in about half an hour.

1. Choose what you sell: fuel only, fuel and lubricants, fuel and shop, or everything.
2. Choose your fuels, enter today's price, and add your tanks (capacity and litres now) and pumps (current meter reading).
3. Finish. Then add your lubricants and shop items under Products. You can paste a list from a spreadsheet to add many at once.
4. Add your attendants under Team. Give each person a username and a password or PIN, and tell them your station code.
5. Open Settings to upload your logo, set your colour and decide whether customers can order online.` },
  { audience: 'admin', slug: 'admin-store', sort: 2, title: 'Your customer store',
    body: `Customers order from your store without creating an account. Open it with the View store button at the top of your screen, and share that web address with customers.

You can turn online ordering off under Settings if you only want to use the sales and stock side. Prices are always shown on the store.` },
  { audience: 'admin', slug: 'admin-products', sort: 3, title: 'Add products and import a list',
    body: `Under Products you can add one item at a time, or use Import to paste rows from a spreadsheet. Each row needs a category, name, size (optional), unit, selling price and starting stock.

Turn on Customers can order for the items you want to show on the store. Fuel sold from pumps cannot be ordered online.` },
  { audience: 'admin', slug: 'admin-change-price', sort: 4, title: 'Change a price',
    body: `Open Prices, choose the product and enter the new price. It takes effect straight away and is saved in the price history.

For fuel, attendants who are on shift with that pump are asked to read the meter at that moment, so old and new prices apply to the right litres. Customers see the new price at once.` },
  { audience: 'admin', slug: 'admin-tanks-pumps', sort: 5, title: 'Tanks and pumps',
    body: `Under Tanks and pumps you can add tanks, add pumps, link each pump to its tank, and see who is using which pump.

If a pump meter is replaced or reset, use Reset meter and give a reason. This sets the new starting reading so the reset is not counted as sales.` },
  { audience: 'admin', slug: 'admin-team', sort: 6, title: 'Staff accounts',
    body: `Under Team, add each attendant with their own username and password. Give them a PIN too if they use a shared tablet. They log in from the Login page using the Staff tab, with your station code.

Never share one login between people. Every sale and change is recorded under the name that made it. To remove someone, turn their account off. Their past records stay.

Admins do not work shifts. They log in with their email address and can review, correct and approve.` },
  { audience: 'admin', slug: 'admin-review-shifts', sort: 7, title: 'Review shifts and flags',
    body: `Shifts lists every shift with what was expected and what was handed over. A flag means something needs a look: cash that does not match, a tank dipstick that differs from the book stock, or an opening reading that did not match the last close.

Open a shift to see every sale, the pump readings and any price changes. If someone leaves without closing, use Close for them and write a note.` },
  { audience: 'admin', slug: 'admin-approvals', sort: 8, title: 'Approve changes to closed shifts',
    body: `Once a shift is closed it is locked. If staff need to cancel a sale or fix cash totals afterwards, they send a request. You will see it under Approvals with the reason. Approve to apply the change, or reject it. Either way it is recorded in the audit trail.` },
  { audience: 'admin', slug: 'admin-monthly-recap', sort: 9, title: 'Monthly recap',
    body: `On the last day of each month the system prepares a recap and tells you. Open Reports and choose Monthly recap to see sales, litres, best sellers, expenses, shortages and a comparison with last month. Download it as a PDF or an Excel file.

Shifts count toward the month they were closed in. A shift still open on the last day is listed as not yet closed.` },
  { audience: 'admin', slug: 'admin-help-guides', sort: 10, title: 'Edit the help guides',
    body: `Under Help guides you can add, edit or delete the guides shown to your customers, your staff and your admins. Use this when something changes or a guide is out of date. You can add a video link to show a screen recording above the text. Restore defaults brings back any standard guide you deleted.` },
  { audience: 'admin', slug: 'admin-exports', sort: 11, title: 'Download your records',
    body: `Under Reports, use Downloads to get sales, expenses, stock movements, price history, the audit log and a fuel volume report as spreadsheet files for your accountant or for regulators.` },
];
