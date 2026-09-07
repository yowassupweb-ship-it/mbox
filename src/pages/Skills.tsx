import { Activity, ArrowRight, Cpu, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchOr } from "../lib/api";
import type { AgentSkill, SkillServiceMode } from "../types";

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
    <div className="skills-board">
      <section className="skills-head">
        <div>
          <span className="eyebrow">что агент умеет сам</span>
          <h1>Навыки</h1>
          <p>Одноразовые вызовы модели без оркестрации инструментами: Джарвис отдаёт их отдельным вызовом, чтобы не тратить свой тесный контекст и квоту. Идут на Gemini, младшая модель oss — только резерв, если Gemini недоступен.</p>
        </div>
        <div className="skills-summary" aria-label="Сводка навыков">
          <strong>{skills.length}</strong>
          <span>{skills.reduce((sum, skill) => sum + skill.calls, 0)} вызовов всего</span>
        </div>
      </section>

      {loading && <p className="muted empty-state">Загрузка навыков</p>}
      {!loading && skills.length === 0 && <p className="muted empty-state">Навыков пока нет</p>}

      <div className="skills-grid">
        {skills.map((skill) => (
          <article className="skill-card" key={skill.id}>
            <div className="skill-card-head">
              <span className="skill-mark" aria-hidden="true"><Zap size={18} /></span>
              <div>
                <span className="skill-owner">{skill.owner}</span>
                <h2>{skill.name}</h2>
              </div>
              <span className="skill-calls" title="Вызовов за всё время / за сутки">
                {skill.calls}<i>{skill.calls_24h} за сутки</i>
              </span>
            </div>
            <p>{skill.summary}</p>
            {skill.trigger && (
              <div className="skill-trigger">
                <code>{skill.trigger}</code>
                <ArrowRight size={14} />
                <code>{skill.id}</code>
              </div>
            )}
            <dl className="skill-io">
              <div><dt>Вход</dt><dd>{skill.input || "—"}</dd></div>
              <div><dt>Выход</dt><dd>{skill.output || "—"}</dd></div>
            </dl>
            <div className="skill-stats">
              <span><Activity size={14} />{formatTokens(skill.tokens)} токенов</span>
              <span><Cpu size={14} />{skill.last_model || "—"}</span>
              <span>{formatLastUsed(skill.last_used_at)}</span>
            </div>
          </article>
        ))}
      </div>

      {modes.length > 0 && (
        <section className="skills-modes">
          <h2>Служебные режимы</h2>
          <p className="muted">Не навыки, но тот же счётчик токенов — с ними видно, сколько на самом деле экономят навыки.</p>
          <table>
            <thead>
              <tr><th>Режим</th><th>Вызовов</th><th>За сутки</th><th>Токенов</th><th>Последний раз</th></tr>
            </thead>
            <tbody>
              {modes.map((mode) => (
                <tr key={mode.id}>
                  <td>{mode.name}</td>
                  <td>{mode.calls}</td>
                  <td>{mode.calls_24h}</td>
                  <td>{formatTokens(mode.tokens)}</td>
                  <td>{formatLastUsed(mode.last_used_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
