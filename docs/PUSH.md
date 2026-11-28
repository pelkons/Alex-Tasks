# Web push notifications

Notifications on the owner's phone (or computer) from the installed web app, with the screen off and the browser closed.
Telegram is unchanged and stays the main channel (it carries the whole conversation and the answer buttons); push is a second,
short signal that opens the right page of the site.

## How it works

- **Keys.** A VAPID key pair is created once at the first use and kept outside the repository in `~/.config/mesimot/vapid.json`
  (mode 600, next to `db.key`; the test instance keeps its own next to its throw-away key). It is never printed or logged.
  The contact sent to the push service is `push_subject` from the configuration, or the site address; never a personal address.
- **Devices.** The switch in Settings (התראות → "התראות במכשיר זה") asks the browser for permission (only on that tap, never on page load),
  subscribes and sends the subscription to `POST /api/push/subscribe`. Table `push_subscriptions` (endpoint unique). A device the push
  service reports as gone (404/410) is deleted at once; other errors are recorded on the device (`last_error`).
- **Queue.** Any process queues a notification in `push_queue` (`lib/push.js` `enqueue`); the runner delivers the queue every 5 seconds,
  health and watchdog deliver their own alert at once. Transient errors (network, 429, 5xx) are retried after 30 s, 1, 2 and 4 minutes;
  each item has a lifetime (TTL, 1 to 12 hours) and is dropped, not sent late, after it. An item that was answered meanwhile
  (a question, a confirmation, an approval) is dropped too.
- **Dedupe and tag.** The same event is queued once (20 hours). Items of one kind share a `tag` (for example all "Alex is waiting for an answer"
  items use `waiting`, a task uses `task:<id>`), so the phone shows one notification per thing; a new one replaces it.
- **Quiet hours and Shabbat** are the same setting as for e-mail and Telegram. An item waits until they end, except system alerts
  (health and watchdog already decide what may break them, exactly as for Telegram) and an answer to a message the owner has just written.

## What is pushed

| Category | When | Default |
|---|---|---|
| תזכורות ויעדים | the daily reminders (08:00, Sunday to Thursday): tasks overdue or due today, one summary | on |
| דורש תשומת לב | the daytime pulse found something and the assistant wrote about it; suggestions | on |
| אלכס מחכה לתשובה | a question with answer buttons, a deletion confirmation, an outgoing-mail approval (the same ones Telegram shows) | on |
| תשובה של אלכס בצ׳אט | the assistant's reply to the owner's message, only when no page of the site is open (a visible page reports every 30 s) | off |
| תקלות במערכת | health and watchdog alerts, and the recovery | on |
| מייל חשוב | live mail the importer marked urgent (a boss, due today or tomorrow, a direct question) | on |

The test button (and `mesimot push test`) sends one test notification to every device, at any hour.

## Privacy: what leaves the server

The push message is encrypted end to end to the device, but it travels through the browser maker's push service
(Google for Chrome on Android, Apple for iPhone, Mozilla for Firefox), which sees when and how big it is.
The payload is only: a short Hebrew title (at most 60 characters), one line (at most 110), a path on this site
(`/task/123`, `/chat`), a tag and the category. Never a mail body; questions and approvals carry no content at all
("אלכס מחכה לתשובה" + "אישור לפני מחיקה"). The full content is on the site, behind the login.

## Install on the phone

The site must be opened over HTTPS (the public address behind the Cloudflare tunnel is). Push works best from the app installed on the home screen.

- **Android (Chrome or Samsung Internet):** open the site, menu ⋮ → "התקנת האפליקציה" / "הוספה למסך הבית". Open Alex Tasks from the
  home screen → Settings → התראות → switch on "התראות במכשיר זה" → allow → "שלח התראת בדיקה".
  If notifications are blocked: Android settings → Apps → Alex Tasks (or Chrome) → Notifications → allow; or in Chrome:
  the lock icon next to the address → Permissions → Notifications → Allow.
- **iPhone (iOS 16.4 or newer):** only from the installed app: Safari → Share → "הוסף למסך הבית", open it from there, then the same switch.

## API (owner's browser session only)

`GET /api/push/key`, `GET /api/push/status?endpoint=`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`,
`POST /api/push/settings` (categories), `POST /api/push/seen` (a visible page). CLI: `mesimot push status | push test`.

## Testing

Unit tests (`test/push.test.js`) mock the push service. `scripts/test-push-ui.js` checks the Settings switch with a stubbed
`Notification` / `PushManager` in headless Chrome. A real delivery through FCM cannot be tested headless on the server: use the test button on the phone.
