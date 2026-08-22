import { useEffect, useState, type ReactNode } from "react";

export type AgentIdentity = {
  key: string;
  label: string;
  accent: string;
  glyph?: ReactNode;
  image?: string;
};

const AVATARS = "/assets/icons/avatars";

function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

export function agentIdentity(name: string): AgentIdentity {
  const raw = (name || "Agent").trim();
  const key = raw.toLowerCase();
  if (key.includes("claude") || key.includes("anthropic")) {
    return { key: "claude", label: raw, accent: "#d97757", image: `${AVATARS}/claude.png` };
  }
  if (key.includes("codex") || key.includes("chatgpt") || key.includes("gpt") || key.includes("openai")) {
    return { key: "openai", label: raw, accent: "#10a37f", image: `${AVATARS}/gpt.png` };
  }
  if (key.includes("gemini") || key.includes("bard") || key.includes("google")) {
    return { key: "gemini", label: raw, accent: "#1a73e8", image: `${AVATARS}/gemini.png` };
  }
  // Джарвис — «свой», постоянный агент MBOX (scripts/mbox-archivist.mjs), не сторонний бренд.
  if (key.includes("джарвис") || key.includes("jarvis")) {
    return { key: "jarvis", label: raw, accent: "#29e0d6", image: "/assets/icons/icons/галочка.png" };
  }
  // Человек — тоже «свой», не бренд ИИ, отдельная аватарка из того же набора.
  if (key.includes("человек") || key === "admin" || key.includes("human")) {
    return { key: "human", label: raw, accent: "#3d8bfd", image: `${AVATARS}/user.png` };
  }
  const hue = hashHue(key || "agent");
  const initials = raw.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "A";
  return { key: "generic", label: raw, accent: `hsl(${hue} 62% 60%)`, glyph: <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="10.5" fontWeight="760" fill="currentColor">{initials}</text> };
}

// Кадры маскота MBOX (осьминог): 1 — логотип в покое, 2-4 — шевелит щупальцами. Пока агент реально
// работает (live), аватарка вместо статичной иконки идентичности крутит эту анимацию — заметный
// живой сигнал "что-то происходит", а не просто цветная точка-статус в углу.
export const WORKING_FRAMES = [1, 2, 3, 4].map((n) => `/assets/icons/big-logo-spinner/${n}.png`);
export const WORKING_FRAME_INTERVAL_MS = 210;

export function useWorkingFrame(active: boolean) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) { setFrame(0); return; }
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % WORKING_FRAMES.length), WORKING_FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
  return WORKING_FRAMES[frame];
}

export function AgentAvatar({ name, status = "idle", live = false, size = 34 }: { name: string; status?: string; live?: boolean; size?: number }) {
  const identity = agentIdentity(name);
  const stateClass = live ? "working" : status;
  const glyphScale = identity.key === "generic" ? 0.62 : 0.56;
  const workingFrame = useWorkingFrame(live);
  const imageSrc = live ? workingFrame : identity.image;
  return (
    <span
      className={`agent-avatar ${identity.key} ${stateClass}${imageSrc ? " has-image" : ""}`}
      style={{ ["--agent-accent" as string]: identity.accent, width: size, height: size }}
      title={`${identity.label} · ${status}`}
      aria-label={`${identity.label}, ${status}`}
    >
      {imageSrc ? (
        <img src={imageSrc} width={Math.round(size * 0.88)} height={Math.round(size * 0.88)} alt="" />
      ) : (
        <svg viewBox="0 0 24 24" width={Math.round(size * glyphScale)} height={Math.round(size * glyphScale)} role="img" aria-hidden="true">
          {identity.glyph}
        </svg>
      )}
    </span>
  );
}
