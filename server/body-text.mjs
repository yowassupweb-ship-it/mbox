// Текст тела запроса. Почти все клиенты шлют UTF-8, но агент с Windows (curl или Invoke-RestMethod из PowerShell, старые консоли)
// присылает кириллицу в Windows-1251 или CP866 без указания кодировки. Раньше тело всегда читалось как UTF-8: такие байты
// превращались в «�» и в базу уходил необратимо испорченный текст (так сломались название и заметка MCP-интеграции,
// добавленной облачным агентом). Теперь: кодировка из Content-Type, иначе строгий UTF-8, иначе та однобайтовая
// кириллица, в которой выходит больше русских букв.

const CYRILLIC = /[А-Яа-яЁё]/g;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function charsetOf(contentType) {
  const match = String(contentType || "").match(/charset\s*=\s*"?([\w-]+)"?/i);
  return match ? match[1].toLowerCase() : "";
}

export function decodeBody(buffer, contentType = "") {
  const bytes = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  const declared = charsetOf(contentType);
  if (declared && !/^utf-?8$/.test(declared)) {
    try { return new TextDecoder(declared).decode(bytes); } catch { /* неизвестная кодировка — угадываем ниже */ }
  }
  try { return utf8.decode(bytes); } catch { /* не UTF-8 */ }
  const variants = ["windows-1251", "ibm866"].map((encoding) => {
    const text = new TextDecoder(encoding).decode(bytes);
    return { text, score: (text.match(CYRILLIC) || []).length };
  });
  return variants.sort((a, b) => b.score - a.score)[0].text;
}
