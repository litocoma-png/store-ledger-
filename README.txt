STORELEDGER OFFLINE — INSTALLATION GUIDE
========================================

WHAT THIS APP DOES
- Product records: name, barcode/SKU, category, supplier, cost, selling price, stock, low-stock threshold and photo.
- Stock units: piece, bag/bags, dozen, length, sheet, box, roll, bottle, can, kg, meter, liter, pack, set, pair or other.
- Optional selling unit conversion (example: inventory counted in pieces, but sold by the dozen).
- Multi-item cash and credit sales, stock deduction, sale history and printable receipts.
- Customer accounts with old unsettled/opening balances, credit purchases and payment allocations.
- Dashboard, low-stock alerts, estimated gross profit and sales totals.
- Full JSON backup/restore and CSV exports.
- Local IndexedDB storage. Core inventory functions do not need an internet connection after the app shell has been cached.

IMPORTANT DATA NOTE
All records are saved in the browser's local database on this device and browser profile. They are not automatically synced to another device. Export the full JSON backup regularly and store it somewhere safe. Browser reset, clearing site data, or device loss may erase local data. Test restore with a backup before relying on it for business-critical records.

WINDOWS INSTALL / RUN
1. Extract the entire StoreLedger-Offline folder to a permanent location, for example C:\StoreLedger-Offline.
2. Install Python 3 from https://www.python.org/downloads/ if it is not already installed. During setup, enable the option to add Python to PATH when available.
3. Open the extracted folder in File Explorer.
4. Click the folder address bar, type cmd, and press Enter. A Command Prompt opens in that folder.
5. Run this command:
       py -m http.server 8000
   If the `py` command is unavailable but Python is installed, try:
       python -m http.server 8000
6. In Chrome or Edge, open:
       http://localhost:8000
7. Wait for the app to load, then refresh once while the server is still running. This gives the service worker a chance to cache the app files for offline use.
8. In Chrome/Edge, use the Install icon in the address bar if shown, or open the browser menu and choose Install StoreLedger / Install this site as an app. Menu wording varies by browser version.
9. Keep the folder in the same place. After it has been installed and cached, test offline mode by turning off Wi-Fi and reopening the installed app.
10. The Command Prompt can then be closed for a basic offline test. If the app does not reopen offline on your browser/device, run the local server again and reinstall/reload while online to the local address.

ANDROID INSTALLATION FROM GITHUB PAGES
This publishes StoreLedger as a secure website that Chrome can install on Android. It is a Progressive Web App (PWA), not an APK and not a Play Store listing. GitHub Pages websites are publicly reachable; do not upload customer records, sales backups, passwords or other private files to the repository.

PUBLISH THE APP
1. Create a GitHub repository for StoreLedger. On GitHub Free, use a public repository for GitHub Pages.
2. Upload the contents of this StoreLedger folder to the repository root. Keep index.html, app.js, manifest.webmanifest, sw.js, logo-header.png and all icon files together at the top level.
3. In the repository, open Settings > Pages.
4. Under Build and deployment, choose Deploy from a branch. Select the main branch and /(root), then click Save.
5. Wait for the Pages deployment to finish in the Actions tab. Open the published site from Settings > Pages. A project site usually looks like https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/.
6. Open that HTTPS address on the Android phone. Keep the repository name and URL path the same when updating the app so the installed site and its local records remain associated with the same address.

INSTALL ON ANDROID
1. On the Android phone, open the published HTTPS site in Chrome.
2. Tap the three-dot menu. Choose Install app, or Install and create shortcut > Install. Menu wording can vary by Chrome version and whether the site meets install criteria.
3. Find the StoreLedger icon on the Home screen or in the app launcher and open it.
4. Keep the phone online for the first visit so the app files can load and cache. Open the installed app once while online after publishing an update; then try offline use.
5. Camera barcode scanning needs a secure site (HTTPS), browser support and camera permission. Manual barcode/SKU entry remains available.

APP DATA AND UPDATES
StoreLedger keeps products, customers, sales and payments in IndexedDB in that browser on that phone. The records are not uploaded to GitHub and are not shared with other phones. Use Reports & Backup > Download full backup and keep the JSON file somewhere private. Push updated app files to the same repository and branch; GitHub Pages will publish the update. Refresh/open the installed app online to receive it. GitHub Pages may take several minutes to publish a change.

LOCAL WINDOWS TESTING
For Windows testing without publishing, use START-WINDOWS.bat or run `py -m http.server 8000` in the app folder, then open http://localhost:8000 in Chrome or Edge. Keep the server window open while testing.

CURRENT INSTALL REFERENCES
GitHub Pages publishing: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
Install a web app on Android: https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en-001

FIRST-TIME SETUP
1. Open Products & Stock and add your products. Enter the current physical stock count, base unit, cost and selling price.
2. For barcoded products, type the barcode/SKU or use Scan if camera scanning is supported. Each barcode/SKU should be unique.
3. For optional selling units, set the conversion carefully. Example: if stock is counted as piece but sales can be by dozen, choose `dozen` and enter 12 as the stock-units-per-optional-unit. The default optional price is base price x factor; enter an optional price if your real selling price differs.
4. Add customers and enter the old unsettled amount in Old unsettled balance. This field is used only when the customer is first created.
5. To make a sale, open New Sale, scan/type a barcode or choose a product, set quantity and unit, then add more items as needed. Choose Cash sale or Credit sale. Credit sales require a customer. Enter the amount received now.
6. To collect an old balance, use Credit Accounts > Record a payment. Payments are allocated to the old opening balance first, then to the oldest unpaid sales.
7. Use Reports & Backup > Download full backup daily or whenever significant records are added. Restore a JSON backup only when you intend to replace the current local database. Delete all app data on that page erases the local records in this browser and cannot be undone; it does not uninstall the app.

LIMITATIONS / PRACTICAL NOTES
- This first version is designed for one device and one browser profile. There is no cloud synchronization, staff login, tax/VAT configuration, supplier purchase-order workflow, or automatic electronic invoice integration.
- Camera barcode support varies by browser and barcode type. Manual entry remains available; many Bluetooth/USB scanners act as a keyboard and can type into barcode fields.
- Receipts use the browser's print dialog. If the print window is blocked, allow pop-ups for localhost or print from Sales History.
- Estimated gross profit is sales value minus recorded product cost; it excludes operating expenses, spoilage, taxes and adjustments.
- Stock editing in a product record sets the current physical stock. Reconcile quantities carefully before entering the starting stock.
- Test the workflow and restore process before using the app as the sole official record for your store.

FILES
- index.html               App interface and styles
- app.js                   Application logic and IndexedDB operations
- sw.js                    Offline cache service worker
- manifest.webmanifest     Installable web-app metadata
- icon.svg                 App icon
- README.txt               This guide


NAVIGATION FIX / UPDATING AN EXISTING INSTALL
If the tabs do not respond, download the latest StoreLedger-Offline ZIP and extract the updated folder. Close every StoreLedger app window, stop any running START-WINDOWS server with Ctrl+C, then start START-WINDOWS.bat again. Open http://localhost:8000 and perform a hard refresh (Ctrl+Shift+R). If installed as a PWA, close the installed app completely and reopen it while connected to the local server once so its offline cache updates. The updated build uses direct tab click handlers and a new service-worker cache version. Existing inventory data in IndexedDB is not intentionally cleared by this update.
