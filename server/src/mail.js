// Outgoing email: sign-up confirmations, password resets and invites to people without an account.
// Sends through an SMTP mailbox (SMTP_HOST) or resend.com (RESEND_API_KEY). With neither, messages go to the log.
function mailer(cfg, log) {
  let smtp = null;
  if (smtpReady(cfg)) {
    const nodemailer = require('nodemailer');
    const implicitTls = cfg.SMTP_PORT === 465;
    smtp = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: implicitTls,
      requireTLS: !implicitTls,  // port 587: always upgrade with STARTTLS, never send the password in the clear
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }
  const replyTo = cfg.MAIL_REPLY_TO || undefined;
  // emails carry sign-in links, so their text is only printed on a local development server, or when a server
  // without email asks for it (MAIL_LOG=on) so its admin can pass the links on
  const printBodies = !String(cfg.PUBLIC_URL).startsWith('https://') || cfg.MAIL_LOG === 'on';

  return async function send({ to, subject, text }) {
    if (smtp) {
      try {
        await smtp.sendMail({ from: cfg.MAIL_FROM, to, subject, text, replyTo });
        return true;
      } catch (e) {
        log(`[mail] "${subject}" failed: ${e.message}`);
        return false;
      }
    }
    if (!cfg.RESEND_API_KEY) {
      if (printBodies) { log(`[mail] to ${to}: ${subject}\n${text}`); return true; }
      log(`[mail] not sent, email isn't set up yet: ${subject}`);
      return false;
    }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.MAIL_FROM, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      if (!r.ok) log(`[mail] send failed (${r.status}): ${await r.text()}`);
      return r.ok;
    } catch (e) {
      log(`[mail] send failed: ${e.message}`);
      return false;
    }
  };
}

// a mailbox login without its password isn't usable yet, so mail goes to the log until it's filled in
const smtpReady = cfg => !!cfg.SMTP_HOST && !(cfg.SMTP_USER && !cfg.SMTP_PASS);

module.exports = { mailer, smtpReady };
