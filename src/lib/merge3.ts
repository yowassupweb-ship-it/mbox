/**
 * Построчное трёхстороннее слияние (diff3): base — общий предок, local — свои правки, remote — чужие.
 * Правки в разных местах сливаются обе; если обе стороны поменяли одно и то же место по-разному,
 * побеждает local, а conflict = true — чтобы показать человеку, что часть чужой правки перекрыта.
 * Заметки и документы по ссылке правят одновременно из MBOX и из браузера — это их общий «сейв».
 */

type Hunk = { start: number; end: number; lines: string[] };

// Сравнение по LCS — квадратичное; больше этого числа пар строк не считаем и отдаём local целиком.
const MAX_CELLS = 4_000_000;

function lcsPairs(a: string[], b: string[]): Array<[number, number]> | null {
  // Общие начало и конец отрезаем сразу: обычно правка — пара строк в середине длинного текста.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > MAX_CELLS) return null;
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[head + i] === b[head + j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let k = 0; k < head; k += 1) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) { pairs.push([head + i, head + j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  for (let k = 0; k < tail; k += 1) pairs.push([a.length - tail + k, b.length - tail + k]);
  return pairs;
}

function hunks(base: string[], other: string[]): Hunk[] | null {
  const pairs = lcsPairs(base, other);
  if (!pairs) return null;
  const result: Hunk[] = [];
  let bi = 0;
  let oi = 0;
  for (const [pb, po] of [...pairs, [base.length, other.length] as [number, number]]) {
    if (pb > bi || po > oi) result.push({ start: bi, end: pb, lines: other.slice(oi, po) });
    bi = pb + 1;
    oi = po + 1;
  }
  return result;
}

function applyHunks(base: string[], start: number, end: number, list: Hunk[]) {
  const out: string[] = [];
  let at = start;
  for (const hunk of list) {
    out.push(...base.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

export function merge3(base: string, local: string, remote: string): { text: string; conflict: boolean } {
  if (local === remote || remote === base) return { text: local, conflict: false };
  if (local === base) return { text: remote, conflict: false };
  const b = base.split("\n");
  const localHunks = hunks(b, local.split("\n"));
  const remoteHunks = hunks(b, remote.split("\n"));
  if (!localHunks || !remoteHunks) return { text: local, conflict: true };

  const all = [...localHunks.map((hunk) => ({ ...hunk, side: "local" as const })), ...remoteHunks.map((hunk) => ({ ...hunk, side: "remote" as const }))]
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let conflict = false;
  let at = 0;
  let index = 0;
  while (index < all.length) {
    // Группа — правки, задевающие одно место оригинала (пересекаются или вставлены в одну точку).
    const group = [all[index]];
    let groupEnd = all[index].end;
    index += 1;
    while (index < all.length && (all[index].start < groupEnd || (all[index].start === groupEnd && (all[index].start === all[index].end || group.some((hunk) => hunk.start === hunk.end && hunk.start === groupEnd))))) {
      groupEnd = Math.max(groupEnd, all[index].end);
      group.push(all[index]);
      index += 1;
    }
    const groupStart = group[0].start;
    out.push(...b.slice(at, groupStart));
    const mine = group.filter((hunk) => hunk.side === "local");
    const theirs = group.filter((hunk) => hunk.side === "remote");
    const mineText = applyHunks(b, groupStart, groupEnd, mine);
    const theirsText = applyHunks(b, groupStart, groupEnd, theirs);
    if (!theirs.length) out.push(...mineText);
    else if (!mine.length) out.push(...theirsText);
    else {
      out.push(...mineText);
      if (mineText.join("\n") !== theirsText.join("\n")) conflict = true;
    }
    at = groupEnd;
  }
  out.push(...b.slice(at));
  return { text: out.join("\n"), conflict };
}
