// Правка текста «заменить фрагмент» для note_edit, doc_edit, edit_skill_file и workspace_edit_file.
//
// Раньше любое расхождение (перенос строки, двойной пробел, «ёлочки» вместо кавычек, правка заметки
// человеком после чтения) давало «old_text not found — перечитай», и агент делал лишний круг.
// Теперь: точное совпадение как раньше; единственное совпадение с точностью до пробелов/переносов/кавычек
// применяется само; иначе ошибка показывает ближайший фрагмент с номером строки — его можно взять как old_text.

const QUOTES = new Map([["‘", "'"], ["’", "'"], ["“", '"'], ["”", '"'], ["«", '"'], ["»", '"'], ["–", "-"], ["—", "-"], [" ", " "]]);

/** Текст без различий в пробелах/переносах/кавычках + карта «позиция в нормализованном → позиция в оригинале». */
function normalizeWithMap(text) {
  let norm = "";
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = QUOTES.get(text[i]) ?? text[i];
    if (/\s/.test(char)) {
      pendingSpace = norm.length > 0;
      continue;
    }
    if (pendingSpace) {
      norm += " ";
      map.push(i);
      pendingSpace = false;
    }
    norm += char;
    map.push(i);
  }
  return { norm, map };
}

function occurrences(text, needle) {
  const found = [];
  if (!needle) return found;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function words(value) {
  return new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []);
}

/** Строка текста, больше всего похожая на начало old_text, с двумя строками контекста по бокам. */
export function closestFragment(text, oldText, maxChars = 700) {
  const lines = text.split("\n");
  const probe = words(oldText.split("\n").find((line) => line.trim()) || oldText);
  if (!probe.size) return null;
  let best = { score: 0, index: -1 };
  lines.forEach((line, index) => {
    const own = words(line);
    if (!own.size) return;
    let shared = 0;
    for (const word of probe) if (own.has(word)) shared += 1;
    const score = shared / (probe.size + own.size - shared);
    if (score > best.score) best = { score, index };
  });
  if (best.score < 0.3) return null;
  const span = Math.min(6, Math.max(1, oldText.split("\n").length));
  const from = Math.max(0, best.index - 1);
  const excerpt = lines.slice(from, best.index + span + 1).join("\n");
  return { line: best.index + 1, text: excerpt.length > maxChars ? `${excerpt.slice(0, maxChars)}…` : excerpt };
}

/**
 * @returns {{ text: string, count: number, fuzzy: boolean }}
 * @throws Error с подсказкой, что делать дальше
 */
export function applyFragmentEdit(text, oldText, newText, { replaceAll = false, what = "the text", reread = "read it again" } = {}) {
  const exact = occurrences(text, oldText);
  if (exact.length === 1 || (exact.length > 1 && replaceAll)) {
    return {
      text: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText),
      count: exact.length,
      fuzzy: false,
    };
  }
  if (exact.length > 1) {
    const lines = exact.slice(0, 8).map((at) => lineOf(text, at)).join(", ");
    throw new Error(`old_text occurs ${exact.length} times (lines ${lines}) — add surrounding text to make it unique or pass replace_all`);
  }

  // Совпадения нет: пробуем без различий в пробелах, переносах и кавычках.
  if (!replaceAll) {
    const source = normalizeWithMap(text);
    const wanted = normalizeWithMap(oldText).norm;
    const hits = occurrences(source.norm, wanted);
    if (wanted && hits.length === 1) {
      const start = source.map[hits[0]];
      const end = source.map[hits[0] + wanted.length - 1] + 1;
      return { text: text.slice(0, start) + newText + text.slice(end), count: 1, fuzzy: true };
    }
    if (wanted && hits.length > 1) {
      throw new Error(`old_text matches ${hits.length} places when whitespace is ignored — add surrounding text to make it unique`);
    }
  }

  const near = closestFragment(text, oldText);
  const advice = near
    ? `Closest fragment (line ${near.line}) — the ${what} was probably edited after you read it; use this as old_text:\n${near.text}`
    : `Nothing similar found — ${reread}.`;
  throw new Error(`old_text not found in ${what} (${text.split("\n").length} lines). ${advice}`);
}
