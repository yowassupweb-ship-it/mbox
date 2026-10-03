import { agentIdentity } from "../../components/AgentAvatar";
import { initialsOf, type AgentPeer, type Peer } from "./presence";

const VISIBLE = 4;

function where(state: Peer["state"]) {
  if (state.cell) return `, ячейка ${state.cell}`;
  if (state.range) return `, диапазон ${state.range}`;
  if (state.typing) return ", печатает";
  return "";
}

/**
 * Кто сейчас в документе — кружки как в Google Docs. Люди — инициалы на цвете, который сервер выдаёт по номеру
 * пользователя (у человека он одинаков в таблице, тексте и заметке); агенты — их собственный значок. Стопка
 * стоит в левой, гибкой части шапки: появление и уход коллеги не сдвигают кнопки справа.
 */
export function PresenceAvatars({ people, agents }: { people: Peer[]; agents: AgentPeer[] }) {
  const total = people.length + agents.length;
  if (!total) return null;
  const shownPeople = people.slice(0, VISIBLE);
  const shownAgents = agents.slice(0, Math.max(0, VISIBLE - shownPeople.length));
  const hidden = total - shownPeople.length - shownAgents.length;
  return (
    <span className="wb-presence" role="group" aria-label={`Сейчас в документе: ${total}`}>
      {shownAgents.map((agent) => {
        const identity = agentIdentity(agent.name);
        return (
          <span key={`agent:${agent.name}`} className="wb-presence-dot is-agent is-writing" style={{ ["--peer" as string]: agent.color || identity.accent }} title={`${agent.name} пишет${agent.range ? `: ${agent.range}` : ""}`}>
            {identity.image ? <img src={identity.image} alt="" draggable={false} /> : initialsOf(agent.name)}
            <span className="wb-presence-sr">{agent.name} пишет</span>
          </span>
        );
      })}
      {shownPeople.map((peer) => (
        <span key={peer.user_id} className="wb-presence-dot" style={{ ["--peer" as string]: peer.color }} title={`${peer.name}${where(peer.state)}`}>
          {initialsOf(peer.name)}
          <span className="wb-presence-sr">{peer.name}{where(peer.state)}</span>
        </span>
      ))}
      {hidden > 0 && <span className="wb-presence-dot is-more" title={`Ещё ${hidden}`}>+{hidden}</span>}
    </span>
  );
}
