# Docket

A day to day task and notes surface for At Once (AOI + AOM), Good Morning Charlie
and Logistics Pit. Static PWA, no build step, no dependencies.

Each venture is a different stock of carbon paper, so you know which business a
line belongs to before you read it: AOI white, AOM canary, GMC rose, PIT blue.

## Deploy

```bash
cd docket
git init && git add -A && git commit -m "Docket v1"
npx vercel --prod
```

Or drag the folder onto vercel.com/new. Any static host works. It must be served
over HTTPS or the service worker will not register.

## Install it

**iPhone** — open the URL in Safari, Share, Add to Home Screen. It launches
full screen with no browser chrome.

**Mac** — Chrome or Edge shows an install icon in the address bar. Safari uses
File > Add to Dock. Either way you get a real app window and a Dock icon.

## Logos and the icon badge

Under the capture bar sit four tiles, one per business, each carrying a live
count of what is open in that lane. Tap one to filter the board to that business
and point new capture at it; tap again to go back to all four.

Until you add a logo the tile shows the three letter code. To add one, open
**Logos** at the bottom of the page and choose a file per business. PNG, JPG,
SVG or WebP. Raster files are scaled to 128px and stored on the device, so four
logos cost a few KB rather than blowing the storage quota. Transparent
backgrounds sit best on the coloured stock — the GMC mark's print resolution
problem does not matter at this size.

**Turn on icon badge** wires up the real thing: the number of items on today's
docket appears on the app icon itself, on the Home Screen and in the Dock. It
needs the app installed (not just open in a tab) and notification permission
granted. Chrome and Edge on macOS support it, as does iOS 16.4 and up for
home screen web apps. Safari on macOS does not, and the button simply will not
appear where it is unsupported.

## Using it

Everything you enter is one stream, whether it is a task or a note. Use the
**Task / Note** toggle on the left of the capture bar to pick which. A task gets
a checkbox; a note gets a folded-corner mark and no checkbox. Both live in the
same lanes, and both can carry a due date.

Type into the bar and press Enter. Two shortcuts get parsed out of the line:

- **Lane:** write `#aoi` `#aom` `#gmc` `#pit` anywhere, or tap a lane tile first.
- **Due date:** end the line with a date phrase and it becomes the due date:
  `tomorrow`, `fri` (next Friday), `next week`, `3d` (in 3 days), `2w`,
  `in 5 days`, or a plain date like `25/12` (day-first). So
  "ring the supplier fri #aom" files an AOM task due Friday.

You can also set or change a date any time: tap **+ Date** on an entry, or tap
an existing date chip, and pick from the calendar. The little X on a chip clears
it. Date chips colour themselves: red when overdue or due today, amber when
due within the week, plain when further out.

### The three views

- **Today** — everything due today, plus anything overdue. This is your docket.
- **Upcoming** — everything with a future date, soonest first.
- **All** — the whole stream, dated entries first, then undated jottings.

Tap a lane tile to filter any view to one business; tap it again for all four.
Keyboard on desktop: `1` Today, `2` Upcoming, `3` All, `n` jump to capture.

## Reminders

The app-icon badge shows how many entries are **overdue or due today** — a
standing nudge on your Home Screen and Dock without opening anything. Turn it on
with **Turn on icon badge** at the bottom (installed app + notification
permission required; works on iOS 16.4+ and Chrome/Edge on macOS).

Note on scope: a PWA can show that badge, but it cannot pop a scheduled alert
while the app is fully closed — that needs a push server, which is a separate
build. If you want true "ping me at 9am when something is due" notifications
later, that is the next step up.

## Sync across your Mac and phone

Docket syncs your tasks and notes through Firebase (Cloud Firestore), so ticking
something on your phone updates the Mac and vice versa. It is a separate free
Google service — deliberately kept off your business infrastructure, and it does
not touch your Supabase project limit. Logos and which view you are looking at
stay per-device on purpose.

Until you add your Firebase config it runs local-only: instant, offline, private
to the one device.

### One-time setup (about ten minutes)

1. **Create a Firebase project.** Go to console.firebase.google.com, sign in
   with your Google account, and click **Add project**. Name it `docket`. You
   can turn Google Analytics off — not needed. No credit card; the free
   (Spark) plan covers this comfortably.

2. **Turn on Google sign-in.** In the project: **Build > Authentication > Get
   started**, then under **Sign-in method** enable **Google** and save. This is
   how you prove it is you across devices.

3. **Create the database.** **Build > Firestore Database > Create database**.
   Choose a location (asia-southeast1 / Singapore is closest to Perth) and start
   in production mode — the rules in the next step lock it down properly.

4. **Add the security rules.** In Firestore Database, open the **Rules** tab,
   replace what is there with the contents of `firestore-rules.txt`, and
   **Publish**. These make each account's board readable and writable only by
   that signed-in user — the thing that keeps your data private even though the
   config below is public.

5. **Copy your web config.** Project settings (gear icon) > **General** > scroll
   to **Your apps** > click the web icon `</>` to register a web app (call it
   Docket). Firebase shows a `firebaseConfig` object. Copy it.

6. **Paste it into `index.html`.** Near the top of the script, drop those values
   into `FIREBASE_CONFIG`:

   ```js
   var FIREBASE_CONFIG = {
     apiKey: "...",
     authDomain: "docket-xxxx.firebaseapp.com",
     projectId: "docket-xxxx",
     appId: "..."
   };
   ```

7. **Authorise your site.** Authentication > **Settings** > **Authorized
   domains** > add your deployed Vercel domain (e.g. `docket.vercel.app`).
   `localhost` is already allowed. Skip this and Google sign-in will refuse to
   run on the live site.

8. **Redeploy** (`vercel --prod`, or drag the folder to vercel.com).

### Using it

Open Docket, tap **Sync** at the bottom, and **Sign in with Google**. On your
Mac it opens a popup; on the phone it does a full-page redirect and comes back
signed in. Do the same on the other device with the **same Google account** and
both show the same board. The pill in the top bar reads Local, Syncing, or
Synced.

Sync is whole-board, last-write-wins: if you somehow edit the same list on both
devices in the same second, the later save wins. For one person on two devices
that effectively never bites. Everything still works offline — changes save
locally and push up next time you are online.

Export and Import at the bottom of the page still work as a manual snapshot,
handy for backups regardless of sync.

## Updating it

Bump `CACHE` in `sw.js` when you change `index.html`, or phones keep serving
the old shell from cache.

Export and Import at the bottom of the page still work as a manual snapshot,
handy for backups regardless of sync.

## Files

```
index.html                 the whole app, HTML + CSS + JS, logos embedded
manifest.webmanifest       name, colours, icons
sw.js                      offline cache
firestore-rules.txt        paste into Firebase to enable cross-device sync
vercel.json                headers config (Firebase auth popups)
api/instagram.js           serverless Instagram feed proxy
README.md                  this file
icon-192 / 512 / maskable  home screen icons
apple-touch-icon.png       iOS home screen
```

## PIT Instagram grid planner

Open it from the **Grid** button on the PIT lane header, or **PIT Grid** in the
footer. It shows a mock Instagram profile with a 3-column grid. Add photos with
**+ Photos**, and arrange them by tapping one then another to swap. Planned
photos carry a small PLAN badge and sit at the top; your real feed loads below a
"Current feed" divider. Planned photos are stored on this device only (they do
not sync).

### Connecting your real feed (optional)

The **Load feed** button pulls your actual Instagram posts through a small
serverless function (`api/instagram.js`) so your planned posts sit on top of
what's already live. This needs a one-time Meta setup:

1. **Make the PIT Instagram a Professional account** (Settings > Account type;
   Business or Creator). Personal accounts cannot use the API.
2. **Create a Meta app** at developers.facebook.com > My Apps > Create App >
   "Business". Add the **Instagram** product ("Instagram API with Instagram
   Login").
3. **Generate a long-lived Instagram user access token** for the PIT account,
   with the `instagram_business_basic` scope. Meta's tool walks you through the
   OAuth step and gives you a token that lasts ~60 days.
4. **Add the token to Vercel:** your docket project > Settings > Environment
   Variables > add `IG_TOKEN` = the token > Save. Then redeploy
   (`vercel --prod`). The token stays server-side and never reaches the browser.
5. In Docket, open PIT Grid and tap **Load feed**.

Tokens expire about every 60 days; the function refreshes yours on each call to
stretch that, but if the feed ever stops loading, generate a fresh token and
update the `IG_TOKEN` env var. If you see "Instagram not connected yet," the
token isn't set or the deploy predates it.

Note: Meta's API only ever returns your OWN account's posts — that's all this
feature needs, and all it can do.
