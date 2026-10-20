import { useState, type ReactNode } from "react";
import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import { getToken, login } from "./api";
import Home from "./pages/Home";
import Activity from "./pages/Activity";
import Crm from "./pages/Crm";
import Feed from "./pages/Feed";
import HotLeads from "./pages/HotLeads";
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
import ManyChat from "./pages/ManyChat";
import ContentPosted from "./pages/ContentPosted";
import Upcoming from "./pages/Upcoming";
import ApiKeys from "./pages/ApiKeys";
import SiteStats from "./pages/SiteStats";
import Digest from "./components/Digest";
import Toasts from "./components/Toast";

const NAV = [
  { to: "/", label: "Home", short: "Home", icon: "home" },
  { to: "/activity", label: "Live Activity", short: "Activity", icon: "activity" },
  { to: "/jobs", label: "Jobs / History", short: "Jobs", icon: "clock" },
  { to: "/feed", label: "Feed Leads", short: "Feed", icon: "upload" },
  { to: "/crm", label: "Clients / CRM", short: "CRM", icon: "users" },
  { to: "/hotleads", label: "Hot Leads", short: "Hot", icon: "flame" },
  { to: "/pipeline", label: "Pipeline", short: "Pipeline", icon: "funnel" },
  { to: "/projects", label: "Projects", short: "Projects", icon: "folder" },
  { to: "/automations", label: "Automations", short: "Auto", icon: "bolt" },
  { to: "/inboxes", label: "Inboxes", short: "Inbox", icon: "inbox" },
  { to: "/emails", label: "Emails", short: "Email", icon: "mail" },
  { to: "/skills", label: "One-Click Run", short: "Run", icon: "play" },
  { to: "/editor", label: "Clip Editor", short: "Clip", icon: "film" },
  { to: "/manychat", label: "ManyChat", short: "DM Bot", icon: "chat" },
  { to: "/content", label: "Content Posted", short: "Posts", icon: "video" },
  { to: "/upcoming", label: "Upcoming", short: "Next", icon: "calendar" },
  { to: "/agentos", label: "AgentOS", short: "Agent", icon: "cpu" },
  { to: "/apikeys", label: "API Keys", short: "Keys", icon: "key" },
  { to: "/sitestats", label: "Site Stats", short: "Stats", icon: "chart" },
  { to: "/brain", label: "Second Brain", short: "Brain", icon: "bulb" },
];

// Hand-drawn line icons (no dependency). Each entry is the inner SVG paths.
const ICONS: Record<string, ReactNode> = {
  home: (<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>),
  activity: (<path d="M3 12h4l3 8 4-16 3 8h4" />),
  chart: (<><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>),
  clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  users: (<><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 6.4" /><path d="M18.5 20a5.5 5.5 0 0 0-2.8-4.8" /></>),
  flame: (<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z" />),
  funnel: (<path d="M3 4.5h18l-7 8v6l-4 2v-8z" />),
  folder: (<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  bolt: (<path d="M13 2 4 14h7l-1 8 9-12h-7z" />),
  inbox: (<><path d="M4 13 6.5 5h11L20 13v6H4z" /><path d="M4 13h5l1 3h4l1-3h5" /></>),
  mail: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 7l8.5 6 8.5-6" /></>),
  play: (<><circle cx="12" cy="12" r="9" /><path d="M10 8.5l5.5 3.5L10 15.5z" /></>),
  film: (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 15h18M8 4v16M16 4v16" /></>),
  chat: (<><path d="M21 12a8 8 0 0 1-8 8H4l2.2-3.3A8 8 0 1 1 21 12z" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></>),
  calendar: (<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M12 13.5v2.5l1.8 1" /></>),
  video: (<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10 9.2l5 2.8-5 2.8z" /></>),
  cpu: (<><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>),
  bulb: (<><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 1 4 10.4c-.7.7-1 1.6-1 2.6H9c0-1-.3-1.9-1-2.6A6 6 0 0 1 12 3z" /></>),
  key: (<><circle cx="8" cy="14" r="4" /><path d="M11 11 20 2" /><path d="M16.5 5.5 19 8M14 8l1.5 1.5" /></>),
  upload: (<><path d="M12 16V4" /><path d="M7.5 8.5 12 4l4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></>),
};

function Icon({ name, className = "" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {ICONS[name] ?? ICONS.home}
    </svg>
  );
}

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
  // desktop sidebar collapse — remembered across reloads
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("nav_collapsed") === "1");
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("nav_collapsed", next ? "1" : "0");
      return next;
    });

  return (
    <div className="h-screen bg-ink text-paper md:flex overflow-hidden">
      {/* DESKTOP — collapsible icon-rail sidebar (Apify-style) */}
      <aside
        className={`hidden md:flex md:flex-col h-screen shrink-0 border-r border-edge transition-[width] duration-200 ${
          collapsed ? "w-16" : "w-56"
        }`}
      >
        <div className={`flex items-center h-16 shrink-0 ${collapsed ? "justify-center" : "px-5"}`}>
          {collapsed ? (
            <span className="font-display text-2xl italic text-signal">T</span>
          ) : (
            <h1 className="font-display text-2xl">
              Tedca <span className="italic text-signal">OS</span>
            </h1>
          )}
        </div>
        <nav className="flex-1 flex flex-col gap-1 px-2 overflow-y-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              title={n.label}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded font-mono text-[11px] uppercase tracking-wider ${
                  collapsed ? "justify-center py-2.5" : "px-3 py-2"
                } ${isActive ? "bg-signal/15 text-signal" : "text-paper/60 hover:text-paper hover:bg-panel"}`
              }
            >
              <Icon name={n.icon} className="w-[18px] h-[18px] shrink-0" />
              {!collapsed && <span className="whitespace-nowrap">{n.label}</span>}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`m-2 flex items-center gap-2 rounded border border-edge py-2 text-paper/50 hover:text-paper hover:bg-panel font-mono text-[11px] ${
            collapsed ? "justify-center" : "px-3"
          }`}
        >
          <span className="text-base leading-none">{collapsed ? "»" : "«"}</span>
          {!collapsed && <span className="uppercase tracking-wider">Collapse</span>}
        </button>
      </aside>

      {/* MAIN */}
      <main className="flex-1 h-screen overflow-y-auto p-4 md:p-8 pb-24 md:pb-8">
        <Digest />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/crm" element={<Crm />} />
          <Route path="/hotleads" element={<HotLeads />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/inboxes" element={<Inboxes />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/editor" element={<ClipEditor />} />
          <Route path="/manychat" element={<ManyChat />} />
          <Route path="/content" element={<ContentPosted />} />
          <Route path="/upcoming" element={<Upcoming />} />
          <Route path="/agentos" element={<AgentOS />} />
          <Route path="/apikeys" element={<ApiKeys />} />
          <Route path="/emails" element={<Emails />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/post-editor" element={<PostEditor />} />
          <Route path="/sitestats" element={<SiteStats />} />
          <Route path="/brain" element={<Brain />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>

      {/* MOBILE — bottom nav bar (thumb-friendly), scrolls horizontally */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 flex overflow-x-auto border-t border-edge bg-ink/95 backdrop-blur">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-1 shrink-0 min-w-[60px] px-2 py-2 font-mono text-[9px] uppercase tracking-wide ${
                isActive ? "text-signal" : "text-paper/55"
              }`
            }
          >
            <Icon name={n.icon} className="w-[22px] h-[22px]" />
            <span className="whitespace-nowrap">{n.short}</span>
          </NavLink>
        ))}
      </nav>

      <Toasts />
    </div>
  );
}
