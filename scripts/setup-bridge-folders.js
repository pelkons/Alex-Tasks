'use strict';
// One-time setup on the real Proton Bridge: creates the assistant's folders (exactly: Labels/Alex-done, Folders/Alex, Folders/tasks.example.org/Inbox, Folders/tasks.example.org/Sent)
// and, with --send-test, sends one short message to the owner and checks that our Sent copy ended up in Folders/tasks.example.org/Sent.
// The folder listing is a diagnostic LIST (names only, no mail is opened). Never prints credentials.
const { ImapFlow } = require('imapflow');
const mail = require('../lib/mail');
process.env.MAIL_PROVIDER = 'imap';
(async () => {
  const s = mail.settings();
  const p = mail.create(process.env);
  console.log('folders:', JSON.stringify(await p.ensureFolders()), '| rename:', p.lastRename);
  const raw = new ImapFlow({ host: s.MAIL_IMAP_HOST || '127.0.0.1', port: +(s.MAIL_IMAP_PORT || 1143), secure: false, doSTARTTLS: true, auth: { user: s.MAIL_IMAP_USER, pass: s.MAIL_IMAP_PASS }, tls: { rejectUnauthorized: false }, logger: false });
  await raw.connect();
  console.log('names as the Bridge shows them (LIST, names only):');
  for (const f of await raw.list()) console.log('  ', f.path, f.specialUse ? `[${f.specialUse}]` : '');
  await raw.logout();
  if (process.argv.includes('--send-test')) {
    const to = process.argv[process.argv.indexOf('--send-test') + 1];
    const r = await p.send({ to, subject: 'אלכס: בדיקת תיקיית נשלחו', text: 'הודעת בדיקה קצרה. העותק שלה אמור להישמר בתיקייה Folders/tasks.example.org/Sent ולא בתיבת הדואר הנכנס.' });
    console.log('sent:', r.messageId, '| copy moved to', 'Folders/tasks.example.org/Sent:', r.sentMoved);
    const c = await mail.create(process.env).listSent();
    console.log('Folders/tasks.example.org/Sent now holds', c.length, 'message(s):', c.map((m) => m.subject).join(' | '));
  }
})().catch((e) => { console.log('FAILED:', e.name, e.message); process.exit(1); });
