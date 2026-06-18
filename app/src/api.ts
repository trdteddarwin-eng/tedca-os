let token: string | null = sessionStorage.getItem("tedca_token");

export function getToken() {
  return token;
}

export function setToken(t: string | null) {
  token = t;
  if (t) sessionStorage.setItem("tedca_token", t);
  else sessionStorage.removeItem("tedca_token");
}

export async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    setToken(null);
    window.location.href = "/";
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export async function login(password: string) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error("Wrong password");
  const data = await res.json();
  setToken(data.token);
  return data.token;
}

// Auto-reconnecting feed. Returns a handle with close(); onStatus reports live/dead.
export function openFeed(
  onEvent: (e: any) => void,
  onStatus?: (live: boolean) => void
): { close: () => void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 1000;

  function connect() {
    if (closed || !token) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
    ws.onopen = () => {
      retry = 1000;
      onStatus?.(true);
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === "activity") onEvent(data.event);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      onStatus?.(false);
      if (!closed) {
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      }
    };
    ws.onerror = () => ws?.close();
  }

  connect();
  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}
