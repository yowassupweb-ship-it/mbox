import { Search } from "lucide-react";
import { useState } from "react";

type TopBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  realtimeState?: "connecting" | "connected" | "thinking" | "working" | "offline";
  realtimeLabel?: string;
  notice?: string;
  notices?: Array<{ id: string; text: string; at: string }>;
};

export function TopBar({ query, onQueryChange, realtimeState = "connecting", realtimeLabel = "Агент подключается", notice = "", notices = [] }: TopBarProps) {
  const [open, setOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="search-shell">
        <Search size={18} />
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Поиск" />
      </div>
      <button className={`realtime-pill monostatus ${realtimeState}`} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <strong>{realtimeLabel}</strong>
        {notice && <span>{notice}</span>}
      </button>
      {open && (
        <div className="agent-status-popover">
          <strong>Действия агента</strong>
          {notices.length ? (
            <div className="agent-status-list">
              {notices.map((item) => (
                <div className="agent-status-item" key={item.id}>
                  <span>{item.text}</span>
                  <time>{item.at}</time>
                </div>
              ))}
            </div>
          ) : <p>Пока нет действий в этой вкладке</p>}
        </div>
      )}
    </header>
  );
}
