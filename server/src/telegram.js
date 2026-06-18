// Telegram notifications (one-way for now; blocking HITL approvals come with M8 part 2).
export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Send a file (audio/photo/video/document) to the user's phone via the bot.
export async function sendTelegramFile(buffer, filename, caption = "", kind = "document") {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return false;
  const method = { audio: "sendAudio", photo: "sendPhoto", video: "sendVideo" }[kind] || "sendDocument";
  const field = { audio: "audio", photo: "photo", video: "video" }[kind] || "document";
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append(field, new Blob([buffer]), filename);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
