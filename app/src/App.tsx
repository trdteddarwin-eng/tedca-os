import { useState } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { getToken, login } from "./api";
import Home from "./pages/Home";
import Activity from "./pages/Activity";
import Crm from "./pages/Crm";
import Pipeline from "./pages/Pipeline";
import Projects from "./pages/Projects";
import Automations from "./pages/Automations";
import Brain from "./pages/Brain";
import Inboxes from "./pages/Inboxes";
import Skills from "./pages/Skills";
import Emails from "./pages/Emails";
import Jobs from "./pages/Jobs";
import PostEditor from "./pages/PostEditor";
import AgentOS from "./pages/AgentOS";
import ClipEditor from "./pages/ClipEditor";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/activity", label: "Live Activity" },
  { to: "/jobs", label: "Jobs / History" },
  { to: "/crm", label: "Clients / CRM" },
  { to: "/pipeline", label: "Pipeline" },
  { to: "/projects", label: "Projects" },
  { to: "/automations", label: "Automations" },
  { to: "/inboxes", label: "Inboxes" },
  { to: "/emails", label: "Emails" },
  { to: "/skills", label: "One-Click Run" },
  { to: "/editor", label: "Clip Editor" },
  { to: "/agentos", label: "AgentOS" },
  { to: "/brain", label: "Second Brain" },
];

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(password);
      onLogin();
    } catch {
      setError("Wrong password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink px-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <h1 className="font-display text-5xl text-paper">
          Tedca <span className="italic text-signal">OS</span>
        </h1>
        <p className="font-mono text-xs text-paper/50 mt-2 mb-8 uppercase tracking-widest">
          Mission control · private
        </p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Passcode"
          className="w-full bg-panel border border-edge rounded px-4 py-3 font-mono text-sm text-paper outline-none focus:border-signal"
        />
        {error && <p className="text-signal text-sm mt-3 font-mono">{error}</p>}
        <button
          disabled={busy || !password}
          className="w-full mt-4 bg-signal text-paper rounded px-4 py-3 font-mono text-sm uppercase tracking-widest disabled:opacity-40 hover:opacity-90"
        >
          {busy ? "…" : "Enter"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  return (
    <div className="min-h-screen bg-ink text-paper flex flex-col md:flex-row">
      <aside className="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-edge p-4 md:p-6">
        <h1 className="font-display text-2xl">
          Tedca <span className="italic text-signal">OS</span>
        </h1>
        <nav className="mt-4 md:mt-8 flex md:flex-col gap-1 overflow-x-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className={({ isActive }) =>
                `px-3 py-2 rounded font-mono text-xs uppercase tracking-wider whitespace-nowrap ${
                  isActive
                    ? "bg-signal/15 text-signal"
                    : "text-paper/60 hover:text-paper hover:bg-panel"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-4 md:p-8 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/crm" element={<Crm />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/inboxes" element={<Inboxes />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/editor" element={<ClipEditor />} />
          <Route path="/agentos" element={<AgentOS />} />
          <Route path="/emails" element={<Emails />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/post-editor" element={<PostEditor />} />
          <Route path="/brain" element={<Brain />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
