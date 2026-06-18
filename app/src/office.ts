// Maps raw activity events to the visual "office" of agents.

export type AgentDef = {
  key: string; // matches activity_events.actor
  name: string;
  role: string;
  desk: string; // short plain-words description of the job
  about: string; // longer plain-words explanation, shown on hover
  nextStep: string; // what this agent will do when it wakes up
  order: number; // position in the morning pipeline
};

export const AGENTS: AgentDef[] = [
  {
    key: "research", name: "Scout", role: "Research", order: 1,
    desk: "Reads the ICP and picks today's target",
    about: "First one awake every morning. Opens your Obsidian brain, reads the med-spa ICP and the winning angle, and decides who today's emails go after and how many leads are needed.",
    nextStep: "Read brain/ ICP note → set today's target niche, city and lead count → hand the brief to Harvester.",
  },
  {
    key: "scrape", name: "Harvester", role: "Scraper", order: 2,
    desk: "Pulls businesses from Google Maps (one Apify run)",
    about: "The lead collector. Checks the lead bank first — leftovers from yesterday get used before anything new. Only if the bank is low does it run ONE Apify scrape (cost rule: never more than one).",
    nextStep: "Check the lead bank → if low, run ONE Apify Google Maps scrape → drop businesses + domains on Inspector's desk.",
  },
  {
    key: "verify", name: "Inspector", role: "Email finder", order: 3,
    desk: "Finds the CEO's email and verifies it",
    about: "Quality control. Takes each business domain, asks AnyMailFinder for the exact CEO email, and checks it's valid. Risky or catch-all addresses go in the bin — only verified emails move on (bounces are what get inboxes flagged).",
    nextStep: "Run each domain through AnyMailFinder → keep valid CEO emails only → pass the clean list to Courier.",
  },
  {
    key: "send", name: "Courier", role: "Sender", order: 4,
    desk: "Sends cold emails across inboxes, safely",
    about: "The mailman. Sends to verified leads only, rotating across all your inboxes with daily caps and random gaps so Google never gets suspicious. Schedules exactly one follow-up and banks leftover leads for tomorrow.",
    nextStep: "Send today's batch across inboxes with caps + jitter → schedule ONE follow-up each → bank the leftovers.",
  },
  {
    key: "reply", name: "Concierge", role: "Reply handler", order: 5,
    desk: "Reads replies and answers or flags them",
    about: "Front of house, on duty 24/7. Watches every inbox for replies. Interested people get a short tailored answer with your patient-engine link. Negative replies get flagged to you on Telegram. 'Stop emailing me' means that lead is never touched again.",
    nextStep: "Poll Gmail for new replies → stop follow-ups for anyone who answered → classify and reply / flag / hard-stop.",
  },
  {
    key: "worker", name: "Mac Worker", role: "Local hands", order: 6,
    desk: "Runs scrapes and Obsidian on your Mac",
    about: "The hands on your Mac. Anything that needs your filesystem — the Apify scrape scripts, reading and writing your Obsidian brain — runs through him, and he streams everything he does into this feed.",
    nextStep: "Stay connected and heartbeat → run scrape/Obsidian jobs the moment the cloud agents ask.",
  },
  {
    key: "system", name: "Dispatch", role: "System", order: 7,
    desk: "Keeps the office running",
    about: "The office manager. Starts runs, watches costs against the $0.50 guardrail, pauses everything when a Telegram approval is needed, and writes the daily summary back to your brain.",
    nextStep: "Wait for the morning run button → open a run, track cost, Telegram you if a decision is needed.",
  },
];

export function lastEventsFor(events: Event[], key: string, n = 3): Event[] {
  return events.filter((e) => e.actor === key).slice(-n).reverse();
}

export type Event = {
  id: number;
  run_id: number | null;
  ts: string;
  actor: string;
  message: string;
  level: string;
};

export type AgentState = {
  def: AgentDef;
  status: "working" | "online" | "standby" | "error";
  statusLabel: string;
  lastMessage: string | null;
  lastTs: string | null;
};

// SQLite stores UTC "YYYY-MM-DD HH:MM:SS".
function ageSeconds(ts: string): number {
  return (Date.now() - new Date(ts.replace(" ", "T") + "Z").getTime()) / 1000;
}

const NOT_BUILT = new Set(["research", "scrape", "verify", "send", "reply"]);

export function deriveStates(events: Event[]): AgentState[] {
  return AGENTS.map((def) => {
    const last = [...events].reverse().find((e) => e.actor === def.key) || null;
    let status: AgentState["status"] = "standby";
    let statusLabel = "Standby";

    if (last) {
      const age = ageSeconds(last.ts);
      if (last.level === "error" && age < 600) {
        status = "error";
        statusLabel = "Needs attention";
      } else if (age < 120) {
        status = "working";
        statusLabel = "Working now";
      } else if (age < 600) {
        status = "online";
        statusLabel = "Online";
      } else {
        status = "standby";
        statusLabel = "Idle";
      }
    } else if (NOT_BUILT.has(def.key)) {
      statusLabel = "Hired — starts soon";
    }

    return {
      def,
      status,
      statusLabel,
      lastMessage: last?.message ?? null,
      lastTs: last?.ts ?? null,
    };
  });
}

// Who works next: first pipeline agent (order 1-5) that isn't currently working.
export function nextUp(states: AgentState[]): AgentState | null {
  const pipeline = states
    .filter((s) => s.def.order <= 5)
    .sort((a, b) => a.def.order - b.def.order);
  const working = pipeline.find((s) => s.status === "working");
  if (working) {
    return pipeline.find((s) => s.def.order === working.def.order + 1) || null;
  }
  return pipeline[0] || null;
}
