import { create, plannerFetch } from "./lib";

/**
 * Люди и агенты для планировщика — вместо чат-стора shar-2. id вида «user:1» / «agent:Claude»: исполнителем задачи
 * может быть и человек, и агент. users — словарь по id, как в shar (экраны читают users[id]).
 */

export type Person = { id: string; name: string; kind: "user" | "agent"; avatar?: string };

type PeopleState = { users: Record<string, Person>; me: string; loaded: boolean };

export const usePeople = create<PeopleState>(() => ({ users: {}, me: "", loaded: false }));

let inflight: Promise<void> | null = null;

export function loadPeople(): Promise<void> {
  if (usePeople.getState().loaded) return Promise.resolve();
  inflight ||= plannerFetch<{ me: string; people: Person[] }>("/api/mbox/planner/people")
    .then((data) => usePeople.setState({ users: Object.fromEntries(data.people.map((person) => [person.id, person])), me: data.me, loaded: true }))
    .catch(() => { /* без списка людей экраны работают, просто без имён */ })
    .finally(() => { inflight = null; });
  return inflight;
}

/** id вошедшего — «user:<id>». До загрузки — пустая строка. */
export const myId = () => usePeople.getState().me;

/** Имя для подписи: человек — логин, агент — его имя; неизвестный id — сам id без префикса. */
export function displayName(person?: Person | null, fallbackId?: string): string {
  if (person) return person.name;
  return fallbackId ? fallbackId.replace(/^(user|agent):/, "") : "";
}
