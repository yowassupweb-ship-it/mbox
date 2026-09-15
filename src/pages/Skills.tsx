import { useEffect, useState } from "react";
import { fetchOr } from "../lib/api";
import type { AgentSkill, SkillServiceMode } from "../types";

/** Навык — одноразовый вызов модели без оркестрации инструментами: Джарвис отдаёт его отдельным
 * вызовом, чтобы не тратить свой тесный контекст и квоту. Идут на Gemini, младшая oss-модель —
 * только резерв, если Gemini недоступен. На экране это не пишем: список говорит сам за себя. */

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function formatLastUsed(value: string | null): string {
  if (!value) return "ни разу";
  const at = new Date(value.replace(" ", "T"));
  if (Number.isNaN(at.getTime())) return "ни разу";
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  return `${days} дн. назад`;
}

export function SkillsBoard() {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [modes, setModes] = useState<SkillServiceMode[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState("");

  useEffect(() => {
    let alive = true;
    fetchOr<{ skills: AgentSkill[]; modes: SkillServiceMode[] }>("/api/mbox/agent/skills", { skills: [], modes: [] })
      .then((data) => {
        if (!alive) return;
        setSkills(data.skills);
        setModes(data.modes);
        setLoading(false);
      })
      .catch(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  return (
    <div className="rows-board">
      <header className="rows-head">
        <h1>Навыки</h1>
        <span>{skills.length} · {skills.reduce((sum, skill) => sum + skill.calls, 0)} вызовов</span>
      </header>

      {loading && <p className="muted empty-state">Загрузка</p>}
      {!loading && skills.length === 0 && <p className="muted empty-state">Навыков пока нет</p>}

      <div className="rows">
        {skills.map((skill) => {
          const open = openId === skill.id;
          return (
            <div className="row-group" key={skill.id}>
              <button type="button" className={open ? "row is-open" : "row"} onClick={() => setOpenId(open ? "" : skill.id)}>
                <span className="row-name">{skill.name}</span>
                <span className="row-dim">{skill.owner}</span>
                <span className="row-num">{skill.calls}</span>
                <span className="row-dim row-num">{formatTokens(skill.tokens)}</span>
                <span className="row-dim">{formatLastUsed(skill.last_used_at)}</span>
              </button>
              {open && (
                <dl className="row-detail">
                  <div><dt>Что делает</dt><dd>{skill.summary}</dd></div>
                  {skill.trigger && <div><dt>Вызов</dt><dd><code>{skill.trigger}</code> → <code>{skill.id}</code></dd></div>}
                  <div><dt>Вход</dt><dd>{skill.input || "—"}</dd></div>
                  <div><dt>Выход</dt><dd>{skill.output || "—"}</dd></div>
                  <div><dt>Модель</dt><dd>{skill.last_model || "—"}</dd></div>
                  {skill.location && <div><dt>Где лежит</dt><dd><code>{skill.location}</code></dd></div>}
                  {skill.id === "email-campaign" && <div><dt>Библиотека блоков</dt><dd><a href="/email-library.html" target="_blank" rel="noreferrer">Открыть шаблоны и блоки</a></dd></div>}
                </dl>
              )}
            </div>
          );
        })}
      </div>

      {modes.length > 0 && (
        <>
          <header className="rows-head sub">
            <h2>Служебные режимы</h2>
            <span>тот же счётчик токенов</span>
          </header>
          <div className="rows">
            {modes.map((mode) => (
              <div className="row is-static" key={mode.id}>
                <span className="row-name">{mode.name}</span>
                <span className="row-dim" />
                <span className="row-num">{mode.calls}</span>
                <span className="row-dim row-num">{formatTokens(mode.tokens)}</span>
                <span className="row-dim">{formatLastUsed(mode.last_used_at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
