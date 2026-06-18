import type { AgentState } from "../office";

// Pixel-art isometric office. Pure SVG, crisp pixels, no images.
// Sleeping agents sit slumped with Zzz; working agents wake, bob and type,
// their monitor glows, and a bubble shows the current task.

const PX = 3; // pixel scale

// 12x11 character sprite. Letters map to palette slots.
// H hair · S skin · E eye · B shirt · A arm(skin)
const BODY: string[] = [
  "..HHHHHHHH..",
  ".HHHHHHHHHH.",
  ".HSSSSSSSSH.",
  ".SS@SSSS@SS.", // @ = eye slot
  ".SSSSSSSSSS.",
  "..SSSSSSSS..",
  "..BBBBBBBB..",
  ".BBBBBBBBBB.",
  "ABBBBBBBBBBA",
  "AABBBBBBBBAA",
  "..BBBBBBBB..",
];

const SHIRTS: Record<string, string> = {
  research: "#d8a23a",
  scrape: "#4f8f4f",
  verify: "#4a7fb5",
  send: "#E63B2E",
  reply: "#9a6bb8",
  worker: "#b8b4ab",
  system: "#666660",
};

function Sprite({
  shirt,
  awake,
  hair = "#2a2018",
}: {
  shirt: string;
  awake: boolean;
  hair?: string;
}) {
  const colors: Record<string, string> = {
    H: hair,
    S: "#e0b08a",
    A: "#e0b08a",
    B: shirt,
    "@": awake ? "#1a1a1a" : "#e0b08a", // closed eyes blend into skin
  };
  const rects: JSX.Element[] = [];
  BODY.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      rects.push(
        <rect key={`${x}-${y}`} x={x * PX} y={y * PX} width={PX} height={PX} fill={colors[ch]} />
      );
      // closed-eye line one pixel below the eye slot
      if (ch === "@" && !awake) {
        rects.push(
          <rect key={`c${x}-${y}`} x={x * PX} y={y * PX + PX - 1} width={PX} height={1} fill="#7a5a40" />
        );
      }
    });
  });
  return <g shapeRendering="crispEdges">{rects}</g>;
}

function Desk({ working }: { working: boolean }) {
  return (
    <g shapeRendering="crispEdges">
      {/* iso desk top */}
      <polygon points="0,18 36,0 84,0 120,18 84,36 36,36" fill="#3a3128" />
      <polygon points="0,18 36,36 84,36 120,18 120,26 84,44 36,44 0,26" fill="#26201a" />
      {/* legs */}
      <rect x="8" y="26" width="4" height="16" fill="#1c1712" />
      <rect x="108" y="26" width="4" height="16" fill="#1c1712" />
      {/* monitor */}
      <rect x="48" y="-22" width="26" height="18" fill="#15130f" />
      <rect x="50" y="-20" width="22" height="14" fill={working ? "#39d98a" : "#23211c"}>
        {working && (
          <animate attributeName="fill" values="#39d98a;#2aa56a;#39d98a" dur="1.2s" repeatCount="indefinite" />
        )}
      </rect>
      <rect x="58" y="-4" width="6" height="4" fill="#15130f" />
      <rect x="52" y="0" width="18" height="2" fill="#15130f" />
      {/* keyboard */}
      <rect x="46" y="8" width="30" height="6" fill="#181510" />
    </g>
  );
}

function Zzz({ x, y }: { x: number; y: number }) {
  return (
    <g className="zzz" fontFamily="Space Mono, monospace" fill="#8a867d">
      <text x={x} y={y} fontSize="11" className="zzz-1">z</text>
      <text x={x + 8} y={y - 9} fontSize="13" className="zzz-2">z</text>
      <text x={x + 18} y={y - 19} fontSize="15" className="zzz-3">Z</text>
    </g>
  );
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function Station({
  state,
  x,
  y,
  isNext,
  hovered,
  onHover,
}: {
  state: AgentState;
  x: number;
  y: number;
  isNext: boolean;
  hovered: boolean;
  onHover: (key: string | null) => void;
}) {
  const working = state.status === "working";
  const awake = working || state.status === "online";
  const error = state.status === "error";
  const bubble = working && state.lastMessage ? clip(state.lastMessage, 34) : null;

  return (
    <g
      transform={`translate(${x},${y})`}
      opacity={awake || hovered ? 1 : 0.8}
      style={{ cursor: "pointer" }}
      onMouseEnter={() => onHover(state.def.key)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onHover(state.def.key)}
    >
      {/* invisible hover hitbox covering the whole station */}
      <rect x="-25" y="-95" width="170" height="180" fill="transparent" />
      {hovered && !working && <ellipse cx="60" cy="40" rx="70" ry="18" fill="#E8E4DD" opacity="0.07" />}
      {/* glow under active desk */}
      {working && <ellipse cx="60" cy="40" rx="70" ry="18" fill="#E63B2E" opacity="0.12" />}
      {/* character behind desk */}
      <g transform={`translate(${42},${-30})`} className={working ? "agent-typing" : undefined}>
        <Sprite shirt={SHIRTS[state.def.key] || "#888"} awake={awake} />
      </g>
      {!awake && !error && <Zzz x={80} y={-34} />}
      <Desk working={working} />
      {/* status lamp */}
      <rect x="-2" y="-2" width="6" height="6" fill={error ? "#E63B2E" : working ? "#39d98a" : awake ? "#4a7fb5" : "#3a3a36"} shapeRendering="crispEdges">
        {(working || error) && (
          <animate attributeName="opacity" values="1;0.3;1" dur="0.9s" repeatCount="indefinite" />
        )}
      </rect>
      {/* nameplate */}
      <text x="60" y="60" textAnchor="middle" fontFamily="Space Mono, monospace" fontSize="10" fill={working ? "#E8E4DD" : "#8a867d"}>
        {state.def.name.toUpperCase()}
      </text>
      <text x="60" y="72" textAnchor="middle" fontFamily="Space Mono, monospace" fontSize="8" fill={error ? "#E63B2E" : working ? "#39d98a" : "#6b6b66"}>
        {error ? "NEEDS ATTENTION" : working ? "WORKING" : isNext ? "WAKES UP NEXT" : awake ? "AWAKE" : "SLEEPING"}
      </text>
      {/* up-next clock sign */}
      {isNext && !working && (
        <g transform="translate(8,-56)" shapeRendering="crispEdges">
          <rect x="0" y="0" width="14" height="14" fill="#15130f" stroke="#8a867d" strokeWidth="1" />
          <rect x="6" y="3" width="2" height="5" fill="#E8E4DD" />
          <rect x="6" y="7" width="4" height="2" fill="#E8E4DD" />
        </g>
      )}
      {/* task bubble */}
      {bubble && (
        <g>
          <rect x="-18" y="-92" width="160" height="26" rx="2" fill="#E8E4DD" shapeRendering="crispEdges" />
          <polygon points="56,-66 64,-66 58,-58" fill="#E8E4DD" />
          <text x="62" y="-75" textAnchor="middle" fontFamily="Space Mono, monospace" fontSize="9" fill="#111">
            {bubble}
          </text>
        </g>
      )}
    </g>
  );
}

export default function OfficeRoom({
  states,
  nextKey,
  hoveredKey,
  onHover,
}: {
  states: AgentState[];
  nextKey: string | null;
  hoveredKey: string | null;
  onHover: (key: string | null) => void;
}) {
  const ordered = [...states].sort((a, b) => a.def.order - b.def.order);
  // two rows: 4 back, 3 front, offset for depth
  const positions = [
    { x: 80, y: 150 }, { x: 290, y: 150 }, { x: 500, y: 150 }, { x: 710, y: 150 },
    { x: 185, y: 320 }, { x: 395, y: 320 }, { x: 605, y: 320 },
  ];

  // iso floor tiles
  const tiles: JSX.Element[] = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 13; c++) {
      const tx = c * 76 + (r % 2) * 38 - 40;
      const ty = 90 + r * 42;
      tiles.push(
        <polygon
          key={`${r}-${c}`}
          points={`${tx},${ty + 21} ${tx + 38},${ty} ${tx + 76},${ty + 21} ${tx + 38},${ty + 42}`}
          fill={(r + c) % 2 ? "#16140f" : "#191712"}
          stroke="#100e0a"
          strokeWidth="1"
        />
      );
    }
  }

  return (
    <div className="bg-[#0d0c09] border border-edge rounded-xl overflow-hidden">
      <svg viewBox="0 0 920 480" className="w-full h-auto block">
        {/* back wall */}
        <rect x="0" y="0" width="920" height="110" fill="#13110d" />
        <rect x="0" y="108" width="920" height="3" fill="#0a0907" />
        {/* window with night sky */}
        <g shapeRendering="crispEdges">
          <rect x="640" y="18" width="120" height="72" fill="#0a1020" stroke="#26201a" strokeWidth="4" />
          <rect x="697" y="18" width="4" height="72" fill="#26201a" />
          <rect x="640" y="52" width="120" height="4" fill="#26201a" />
          <rect x="664" y="32" width="3" height="3" fill="#E8E4DD" opacity="0.8" />
          <rect x="736" y="40" width="3" height="3" fill="#E8E4DD" opacity="0.5" />
          <rect x="676" y="66" width="3" height="3" fill="#E8E4DD" opacity="0.6" />
          <rect x="716" y="26" width="6" height="6" fill="#d8d2c4" />
        </g>
        {/* wall sign */}
        <g fontFamily="Space Mono, monospace">
          <rect x="60" y="30" width="190" height="44" fill="#15130f" stroke="#26201a" strokeWidth="3" shapeRendering="crispEdges" />
          <text x="155" y="49" textAnchor="middle" fontSize="13" fill="#E63B2E" fontWeight="bold">TEDCA HQ</text>
          <text x="155" y="65" textAnchor="middle" fontSize="8" fill="#8a867d">COLD EMAIL DIVISION</text>
        </g>
        {/* hanging lamp */}
        <g shapeRendering="crispEdges">
          <rect x="448" y="0" width="3" height="34" fill="#26201a" />
          <polygon points="430,34 470,34 462,48 438,48" fill="#3a3128" />
          <rect x="444" y="44" width="12" height="5" fill="#f5e6b8" opacity="0.9" />
        </g>
        {tiles}
        {ordered.map((s, i) => (
          <Station
            key={s.def.key}
            state={s}
            x={positions[i]?.x ?? 80}
            y={positions[i]?.y ?? 150}
            isNext={s.def.key === nextKey}
            hovered={hoveredKey === s.def.key}
            onHover={onHover}
          />
        ))}
      </svg>
    </div>
  );
}
