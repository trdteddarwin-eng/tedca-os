// End-to-end smoke test: login → stats → trigger event → receive it on the WebSocket feed.
import WebSocket from "ws";

const BASE = "http://localhost:8790";
const password = process.env.OS_PASSWORD || "tedca-dev";

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { token } = await login.json();
console.log("1. login OK");

const auth = { Authorization: `Bearer ${token}` };
const stats = await (await fetch(`${BASE}/api/stats`, { headers: auth })).json();
console.log("2. stats OK:", JSON.stringify(stats));

const ws = new WebSocket(`ws://localhost:8790/ws?token=${token}`);
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});
console.log("3. WebSocket connected");

const got = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("no live event within 3s")), 3000);
  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === "activity") {
      clearTimeout(t);
      res(data.event);
    }
  });
});

await fetch(`${BASE}/api/activity/test`, { method: "POST", headers: auth });
const event = await got;
console.log("4. live event received over WS:", event.message);

const activity = await (await fetch(`${BASE}/api/activity?limit=5`, { headers: auth })).json();
console.log("5. recent activity:");
for (const e of activity) console.log(`   [${e.actor}] ${e.message}`);

ws.close();
console.log("ALL CHECKS PASSED");
