// Unified inbox pool: merges Gmail-API inboxes (OAuth) and Zapmail SMTP inboxes
// (app passwords) so the engine sends through whichever transport an inbox uses.
// Sending only — reply reading stays per-transport (Gmail API vs IMAP).
import { authorizedInboxes as gmailAuthorized, sendEmail } from "./gmail.js";
import { smtpInboxes, isSmtpInbox, sendEmailSMTP } from "./smtp.js";

// every inbox the engine may send from right now, tagged by transport
export function sendingInboxes() {
  const gmail = gmailAuthorized()
    .filter((i) => i.authorized)
    .map((i) => ({ email: i.email, transport: "gmail" }));
  const smtp = smtpInboxes().map((email) => ({ email, transport: "smtp" }));
  return [...gmail, ...smtp];
}

export function isSmtp(email) {
  return isSmtpInbox(email);
}

// route a send to the right transport; same shape as gmail.js sendEmail()
export async function sendVia({ from, to, subject, body, inReplyTo = null, attachments = [] }) {
  // Hard kill-switch. When SEND_DISABLED=1 (set ONLY on the dormant cloud instance during
  // bring-up) no email can leave this process regardless of DB test_mode/schedule settings —
  // the backstop against double-sending real prospects while the Mac is still the live sender.
  // Removed (with the Mac paused) at the Phase-2 cutover. The Mac never sets it, so this is a
  // no-op there and Mac behavior is unchanged.
  if (process.env.SEND_DISABLED === "1") {
    throw new Error("SEND_DISABLED: outbound sending is turned off on this instance");
  }
  if (isSmtpInbox(from)) return sendEmailSMTP({ from, to, subject, body, inReplyTo, attachments });
  return sendEmail({ from, to, subject, body, inReplyTo, attachments });
}
