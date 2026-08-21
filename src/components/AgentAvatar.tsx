import type { ReactNode } from "react";

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
  // Фирменный цвет MBOX вместо хеша, чтобы глаз сразу выделял его среди Claude/Codex/Gemini.
  if (key.includes("джарвис") || key.includes("jarvis")) {
    return {
      key: "generic",
      label: raw,
      accent: "#29e0d6",
      glyph: <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="10.5" fontWeight="760" fill="currentColor">Д</text>,
    };
  }
  // Человек — тоже «свой», не бренд ИИ, отдельная аватарка из того же набора.
  if (key.includes("человек") || key === "admin" || key.includes("human")) {
    return { key: "human", label: raw, accent: "#3d8bfd", image: `${AVATARS}/user.png` };
  }
  const hue = hashHue(key || "agent");
  const initials = raw.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "A";
  return { key: "generic", label: raw, accent: `hsl(${hue} 62% 60%)`, glyph: <text x="12" y="12" textAnchor="middle" dominantBaseline="central" fontSize="10.5" fontWeight="760" fill="currentColor">{initials}</text> };
}

export function AgentAvatar({ name, status = "idle", live = false, size = 34 }: { name: string; status?: string; live?: boolean; size?: number }) {
  const identity = agentIdentity(name);
  const stateClass = live ? "working" : status;
  const glyphScale = identity.key === "generic" ? 0.62 : 0.56;
  return (
    <span
      className={`agent-avatar ${identity.key} ${stateClass}${identity.image ? " has-image" : ""}`}
      style={{ ["--agent-accent" as string]: identity.accent, width: size, height: size }}
      title={`${identity.label} · ${status}`}
      aria-label={`${identity.label}, ${status}`}
    >
      {identity.image ? (
        <img src={identity.image} width={Math.round(size * 0.8)} height={Math.round(size * 0.8)} alt="" style={{ borderRadius: "50%" }} />
      ) : (
        <svg viewBox="0 0 24 24" width={Math.round(size * glyphScale)} height={Math.round(size * glyphScale)} role="img" aria-hidden="true">
          {identity.glyph}
        </svg>
      )}
    </span>
  );
}
