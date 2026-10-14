import type { LocalKind } from "../hooks/useMboxData";
import { showNotice } from "../ui/askText";
import { fetchJson } from "./api";

/**
 * Удалить и изменить «сразу»: строка пропадает (или меняется) на экране в момент действия, сервер подтверждает
 * в фоне, а перечитывается только затронутый список. Раньше после удаления ждали, пока заново скачаются все
 * двенадцать списков — через туннель это десятки секунд, и удалённое долго висело на месте. Если сервер откажет,
 * перечитывание вернёт строку, а человек увидит, почему.
 */

type LocalData = {
  drop: (kind: LocalKind, id: string) => void;
  patchLocal: (kind: LocalKind, id: string, patch: Record<string, unknown>) => void;
  reload: (entity?: unknown) => void;
};

/** Какая realtime-сущность у списка — по ней перечитывается только нужное. */
const ENTITY: Record<LocalKind, string> = {
  artifacts: "artifacts",
  projects: "projects",
  companies: "companies",
  folders: "folders",
  memories: "memories",
  decisions: "decision_log",
  todos: "todos",
};

const API: Record<LocalKind, string> = {
  artifacts: "artifacts",
  projects: "projects",
  companies: "companies",
  folders: "folders",
  memories: "memories",
  decisions: "decisions",
  todos: "todos",
};

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^.*:(\d{3})$/, "сервер ответил $1");

export async function removeNow(data: LocalData, kind: LocalKind, ids: string | string[]) {
  const list = Array.isArray(ids) ? ids : [ids];
  list.forEach((id) => data.drop(kind, id));
  const failed: string[] = [];
  await Promise.all(list.map((id) => fetchJson(`/api/mbox/${API[kind]}/${id}`, { method: "DELETE" }).catch((error) => { failed.push(reason(error)); })));
  data.reload(ENTITY[kind]);
  if (failed.length) showNotice("Не удалилось", failed.length === list.length ? failed[0] : `Не удалось удалить ${failed.length} из ${list.length}: ${failed[0]}`);
  return failed.length === 0;
}

export async function patchNow(data: LocalData, kind: LocalKind, id: string, body: Record<string, unknown>, local: Record<string, unknown> = body) {
  data.patchLocal(kind, id, local);
  try {
    await fetchJson(`/api/mbox/${API[kind]}/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return true;
  } catch (error) {
    showNotice("Не сохранилось", reason(error));
    return false;
  } finally {
    data.reload(ENTITY[kind]);
  }
}
