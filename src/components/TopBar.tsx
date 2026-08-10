import { Search } from "lucide-react";

type TopBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  realtimeState?: "connecting" | "connected" | "thinking" | "working" | "offline";
  realtimeLabel?: string;
  notice?: string;
};

export function TopBar({ query, onQueryChange, realtimeState = "connecting", realtimeLabel = "Агент подключается", notice = "" }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="search-shell">
        <Search size={18} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Поиск" />
      </div>
      <div className={`realtime-pill monostatus ${realtimeState}`}>
        <strong>{realtimeLabel}</strong>
        {notice && <span>{notice}</span>}
      </div>
    </header>
  );
}
