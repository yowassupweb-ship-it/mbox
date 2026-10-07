import { serverOrigin } from "../../lib/serverOrigin";

export type PersonalTask = { id: string; title: string; description: string; due_at: string | null; recurrence_rule: string | null; completed_at: string | null };
export type CalendarEvent = { id: string; master_id?: string; title: string; description: string; starts_at: string; ends_at: string; all_day: boolean; location: string; color: string; reminder_minutes: number | null; recurrence_rule: string | null };

export async function plannerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${serverOrigin()}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!response.ok) throw new Error(`planner_${response.status}`);
  return response.json() as Promise<T>;
}
