/*
 * LetterKit — ядро конструктора писем «Вокруг света». Один и тот же файл выполняют:
 *   - страница library.html во вкладке MBOX (читает его через mbox.read и запускает),
 *   - скрипт агента scripts/letter.mjs (сборка, проверка, отчёт).
 * Поэтому одинаковое письмо (letters/<id>.json) всегда даёт одинаковый HTML — конструктор предсказуем.
 *
 * Компонент — components/C###.html: HTML-строка <tr em="block"> с полями {{ключ}}. Описание полей — в
 * components/registry.json (label, type, required, default). Модификаторы:
 *   {{ключ}}       — текст, экранируется;
 *   {{ключ|text}}  — многострочный текст: пустая строка → абзац, **жирный** → <strong>;
 *   {{ключ|url}}   — ссылка (экранируется; UTM добавляет сборка письма).
 * Форматирование текстового поля хранится рядом с fields в item.formats:
 *   { "title": { "fontSize": 28, "color": "#172b25", "bold": true } }
 * Оно превращается только в безопасные inline-стили, совместимые с почтовыми клиентами.
 * Оболочка — components/shell.html: <head>, стили, прехедер и метка <!--MBOX:COMPONENTS-->.
 * Без зависимостей: работает в браузере и в node.
 */
(function (root) {
  'use strict';

  var MARK = '<!--MBOX:COMPONENTS-->';
  var SOCIAL = ['vk.com', 'vk.me', 't.me', 'wa.me', 'viber.com', 'clck.ru', 'dzen.ru', 'max.ru'];
  var FIELD = /\{\{\s*([a-z0-9_]+)(?:\|(text|url))?\s*\}\}/gi;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function richText(value) {
    return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().split(/\n{2,}/).map(function (paragraph) {
      return escapeHtml(paragraph).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    }).join('<br><br>');
  }

  /** Ключи полей шаблона в порядке появления. */
  function templateFields(template) {
    var keys = [];
    String(template || '').replace(FIELD, function (_, key) { if (keys.indexOf(key) < 0) keys.push(key); return ''; });
    return keys;
  }

  function componentById(registry, id) {
    var list = (registry && registry.components) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
    return null;
  }

  /** Значения полей с учётом default из реестра. */
  function valuesFor(component, fields) {
    var values = {};
    ((component && component.fields) || []).forEach(function (field) {
      var given = fields && Object.prototype.hasOwnProperty.call(fields, field.key) ? fields[field.key] : undefined;
      values[field.key] = given === undefined || given === null ? (field.default == null ? '' : field.default) : given;
    });
    Object.keys(fields || {}).forEach(function (key) { if (!(key in values)) values[key] = fields[key]; });
    return values;
  }

  function normalizeFormat(value) {
    var source = value && typeof value === 'object' ? value : {};
    var size = Number(source.fontSize);
    var color = String(source.color || '').trim();
    return {
      fontSize: Number.isFinite(size) && size >= 8 && size <= 72 ? Math.round(size) : null,
      color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : '',
      bold: source.bold === true,
    };
  }

  function wrapTextField(content, key, value, format, options, multiline) {
    var normalized = normalizeFormat(format);
    var style = [];
    if (normalized.fontSize) style.push('font-size:' + normalized.fontSize + 'px');
    if (normalized.color) style.push('color:' + normalized.color);
    if (normalized.bold) style.push('font-weight:700');
    if (!style.length && !(options && options.editable)) return content;
    var attrs = style.length ? ' style="' + style.join(';') + '"' : '';
    if (options && options.editable) {
      attrs += ' data-mbox-item="' + escapeHtml(options.itemIndex) + '"';
      attrs += ' data-mbox-field="' + escapeHtml(key) + '"';
      attrs += ' data-mbox-value="' + escapeHtml(value) + '"';
      attrs += ' data-mbox-multiline="' + (multiline ? 'true' : 'false') + '" tabindex="0"';
    }
    return '<span' + attrs + '>' + content + '</span>';
  }

  function renderComponent(component, template, fields, position, formats, options) {
    var errors = [];
    var values = valuesFor(component, fields);
    var label = (component ? component.id : '?') + (position ? ' (позиция ' + position + ')' : '');
    ((component && component.fields) || []).forEach(function (field) {
      if (field.required && !String(values[field.key] || '').trim()) errors.push(label + ': не заполнено поле «' + (field.label || field.key) + '»');
      if (field.type === 'url' && String(values[field.key] || '').trim() && !/^(https?:\/\/|mailto:|tel:)/i.test(String(values[field.key]).trim())) errors.push(label + ': «' + (field.label || field.key) + '» — не ссылка: ' + values[field.key]);
      if (field.type === 'image' && String(values[field.key] || '').trim() && !/^https:\/\//i.test(String(values[field.key]).trim())) errors.push(label + ': картинка «' + (field.label || field.key) + '» должна быть https-ссылкой');
    });
    var html = String(template || '').replace(FIELD, function (_, key, mode, offset, whole) {
      var value = values[key];
      var raw = String(value == null ? '' : value);
      var content = mode === 'text' ? richText(raw) : escapeHtml(raw.trim());
      var before = whole.slice(0, offset);
      var insideTag = before.lastIndexOf('<') > before.lastIndexOf('>');
      if (mode === 'url' || insideTag) return content;
      var field = ((component && component.fields) || []).find(function (item) { return item.key === key; });
      var isText = !field || field.type === 'text' || field.type === 'multiline';
      return isText ? wrapTextField(content, key, raw, formats && formats[key], options, mode === 'text' || (field && field.type === 'multiline')) : content;
    });
    return { html: html.trim(), errors: errors };
  }

  function decodeAttr(value) {
    return String(value).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }

  /** Единые UTM на все http(s)-ссылки, кроме соцсетей и карт; старые utm_* убираются. */
  function applyUtm(html, utm) {
    var campaign = utm && String(utm.campaign || '').trim();
    var content = utm && String(utm.content || '').trim();
    if (!campaign && !content) return html;
    return String(html).replace(/(<a\b[^>]*?\bhref\s*=\s*")([^"]*)(")/gi, function (whole, before, href, after) {
      var url;
      try { url = new URL(decodeAttr(href)); } catch (e) { return whole; }
      if (!/^https?:$/.test(url.protocol)) return whole;
      var host = url.hostname;
      var social = SOCIAL.some(function (domain) { return host === domain || host.slice(-domain.length - 1) === '.' + domain; });
      if (social || (host === 'yandex.ru' && url.pathname.indexOf('/maps/') === 0)) return whole;
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (name) { url.searchParams.delete(name); });
      url.searchParams.set('utm_source', 'email');
      url.searchParams.set('utm_medium', 'email');
      if (campaign) url.searchParams.set('utm_campaign', campaign);
      if (content) url.searchParams.set('utm_content', content);
      return before + url.toString().replace(/&/g, '&amp;') + after;
    });
  }

  /**
   * Письмо целиком: оболочка + компоненты по порядку. kit = { registry, templates: {C###: html}, shell }.
   * Возвращает html и errors (незаполненные обязательные поля, неизвестные номера, нет UTM).
   */
  function renderLetter(letter, kit, options) {
    var body = (letter && letter.letter) || {};
    var errors = [];
    var warnings = [];
    var rows = (body.items || []).map(function (item, index) {
      var component = componentById(kit.registry, item.component);
      var template = kit.templates && kit.templates[item.component];
      if (!component || !template) { errors.push('Позиция ' + (index + 1) + ': нет компонента ' + item.component); return ''; }
      var itemOptions = options && options.editable ? { editable: true, itemIndex: index } : null;
      var result = renderComponent(component, template, item.fields || {}, index + 1, item.formats || {}, itemOptions);
      errors.push.apply(errors, result.errors);
      // В редакторе конструктора строки блока помечаются его позицией: клик по блоку в предпросмотре
      // выделяет его в составе. В готовый HTML (без editable) метка не попадает.
      if (itemOptions) return result.html.replace(/<tr\b/gi, '<tr data-mbox-block="' + index + '"');
      return result.html;
    });
    if (!rows.length) errors.push('В письме нет компонентов');
    if (!String(body.subject || '').trim()) errors.push('Не задана тема письма');
    if (!String(body.preheader || '').trim()) warnings.push('Не задан прехедер');
    var utm = body.utm || {};
    if (!String(utm.campaign || '').trim()) errors.push('Не задана UTM-кампания');
    if (!String(utm.content || '').trim()) errors.push('Не задан utm_content (идентификатор выпуска)');
    var shell = String(kit.shell || '<!DOCTYPE html><html><head><title>{{subject}}</title></head><body>' + MARK + '</body></html>');
    var html = shell
      .replace(/\{\{\s*subject\s*\}\}/g, escapeHtml(body.subject || ''))
      .replace(/\{\{\s*preheader\s*\}\}/g, escapeHtml(body.preheader || ''))
      .replace(MARK, rows.join('\n'));
    return { html: applyUtm(html, utm), errors: errors, warnings: warnings };
  }

  // ── Разбор готового письма на блоки ────────────────────────────────────────────────
  // Обратный ход сборки: HTML письма → строки-блоки → номер компонента и значения полей. Нужен в работе:
  // правка присланного или старого письма, перенос письма из UniSender, пополнение библиотеки новыми блоками.
  // Без DOM — работает и в браузере, и в node (scripts/letter.mjs parse).

  function decodeEntities(value) {
    return String(value == null ? '' : value)
      .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
      .replace(/&amp;/gi, '&');
  }

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  /** Ссылка без utm_* в том виде, в каком её сериализует applyUtm: шаблон и письмо сравниваются одинаково. */
  function cleanHref(href) {
    var url;
    try { url = new URL(decodeAttr(href)); } catch (e) { return href; }
    if (!/^https?:$/.test(url.protocol)) return href;
    UTM_KEYS.forEach(function (name) { url.searchParams.delete(name); });
    return url.toString().replace(/&/g, '&amp;');
  }

  /** Сравнимый вид HTML: без комментариев (кроме метки), пробелы схлопнуты, ссылки без UTM. */
  function normalizeHtml(html) {
    return String(html || '')
      .replace(/<!--(?!MBOX)[\s\S]*?-->/g, '')
      .replace(/(<a\b[^>]*?\bhref\s*=\s*")([^"]*)(")/gi, function (_, before, href, after) { return before + cleanHref(href) + after; })
      .replace(/\s+/g, ' ').replace(/>\s+</g, '><').replace(/\s+>/g, '>').trim();
  }

  /**
   * Строки-блоки письма. Сначала — строки <tr em="block"> верхнего уровня (так размечены все письма навыка
   * и шаблоны UniSender). Нет разметки — прямые строки таблицы, где их больше всего (основная колонка письма).
   * Возвращает { blocks: [html], source: 'em-block' | 'table-rows' | 'none' }.
   */
  function splitBlocks(html) {
    var text = String(html || '');
    var tag = /<(\/?)(tr|table)\b([^>]*)>/gi;
    var stack = [];
    var blocks = [];
    var tables = [];
    var match;
    while ((match = tag.exec(text))) {
      var closing = match[1] === '/';
      var name = match[2].toLowerCase();
      if (!closing && name === 'table') { var t = { rows: [], depth: stack.length }; stack.push({ name: 'table', table: t }); tables.push(t); continue; }
      if (!closing && name === 'tr') {
        var parent = null;
        for (var i = stack.length - 1; i >= 0; i -= 1) if (stack[i].name === 'table') { parent = stack[i].table; break; }
        var insideBlock = stack.some(function (entry) { return entry.block; });
        stack.push({ name: 'tr', start: match.index, table: parent, block: !insideBlock && /\bem\s*=\s*["']?block\b/i.test(match[3]) });
        continue;
      }
      // Закрывающий тег: снимаем до ближайшего такого же (кривой HTML с незакрытыми тегами не роняет разбор).
      for (var j = stack.length - 1; j >= 0; j -= 1) {
        if (stack[j].name !== name) continue;
        var entry = stack[j];
        stack.length = j;
        if (name === 'tr') {
          var row = text.slice(entry.start, tag.lastIndex);
          if (entry.block) blocks.push(row);
          if (entry.table) entry.table.rows.push(row);
        }
        break;
      }
    }
    if (blocks.length) return { blocks: blocks, source: 'em-block' };
    var best = null;
    tables.forEach(function (table) { if (table.rows.length >= 2 && (!best || table.rows.length > best.rows.length || (table.rows.length === best.rows.length && table.depth > best.depth))) best = table; });
    if (best) return { blocks: best.rows.map(function (row) { return /\bem\s*=/i.test(row.slice(0, row.indexOf('>'))) ? row : row.replace(/^<tr\b/i, '<tr em="block"'); }), source: 'table-rows' };
    return { blocks: [], source: 'none' };
  }

  function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  var matcherCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  /** Шаблон компонента → регулярное выражение: текст шаблона буквально, на месте полей — группы. */
  function matcherFor(template) {
    var source = normalizeHtml(template);
    var keys = [];
    var pattern = '';
    var literal = 0;
    var last = 0;
    source.replace(FIELD, function (whole, key, mode, offset) {
      var chunk = source.slice(last, offset);
      pattern += escapeRegExp(chunk);
      literal += chunk.length;
      var before = source.slice(0, offset);
      var insideTag = before.lastIndexOf('<') > before.lastIndexOf('>');
      pattern += insideTag ? '([^"<>]*?)' : '([\\s\\S]*?)';
      keys.push({ key: key, mode: mode || '', insideTag: insideTag });
      last = offset + whole.length;
      return whole;
    });
    pattern += escapeRegExp(source.slice(last));
    literal += source.length - last;
    return { regex: new RegExp('^' + pattern + '$'), keys: keys, literal: literal, rows: splitBlocks(template).blocks.length || 1 };
  }

  function styleFormat(style) {
    var format = {};
    var size = /font-size:\s*(\d+)px/i.exec(style);
    var color = /(?:^|;)\s*color:\s*(#[0-9a-f]{6})/i.exec(style);
    if (size) format.fontSize = Number(size[1]);
    if (color) format.color = color[1].toLowerCase();
    if (/font-weight:\s*(700|bold)/i.test(style)) format.bold = true;
    return normalizeFormat(format);
  }

  function fieldValue(raw, spec) {
    var value = raw;
    var format = null;
    if (!spec.insideTag && spec.mode !== 'url') {
      var span = /^<span style="([^"]*)">([\s\S]*)<\/span>$/.exec(value);
      if (span) { format = styleFormat(span[1]); value = span[2]; }
    }
    // Переносы по краям — вёрстка вокруг поля, а не его текст («5-6 января<br><br>»).
    if (!spec.insideTag) value = value.replace(/^(\s*<br\s*\/?>)+|(<br\s*\/?>\s*)+$/gi, '');
    if (spec.mode === 'text') {
      value = value.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
    } else if (!spec.insideTag) {
      // Ручной перенос в заголовке («Родина дымковской <br>сказки») — простое поле его не хранит, остаётся пробел.
      value = value.replace(/\s*<br\s*\/?>\s*/gi, ' ');
    }
    // Оставшиеся теги или обрывки CSS значат, что поле «съело» чужую вёрстку: это не тот компонент.
    var invalid = !spec.insideTag && (/<[a-z/!]/i.test(value) || /[;"]\s*(line-height|color|font-size|text-align)\s*:/i.test(value));
    value = decodeEntities(value).replace(/ /g, ' ').trim();
    return { value: value, invalid: invalid, format: format && (format.fontSize || format.color || format.bold) ? format : null };
  }

  // Второй проход — по структуре: письмо из UniSender или старый выпуск свёрстаны «почти как шаблон»
  // (другие пробелы, порядок и стили атрибутов, правленый текст кнопок), и буквальное сравнение их не узнаёт.
  // Совпасть должна последовательность тегов; значения полей берутся из тех же мест — текст, href, src, alt.
  var INLINE = /^\/?(br|strong|b|span|em|i|u|sup|sub|font|wbr)$/;
  var WHOLE_FIELD = /^\s*\{\{\s*([a-z0-9_]+)(?:\|(text|url))?\s*\}\}\s*$/i;

  function attrsOf(tag) {
    var attrs = {};
    tag.replace(/([a-z_:][-a-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, function (whole, name, _, dq, sq, uq) {
      attrs[name.toLowerCase()] = dq != null ? dq : sq != null ? sq : uq;
      return whole;
    });
    return attrs;
  }

  function tokensOf(html) {
    var out = [];
    var re = /<[^>]+>|[^<]+/g;
    var source = normalizeHtml(html);
    var m;
    while ((m = re.exec(source))) {
      var raw = m[0];
      if (raw.charAt(0) === '<') {
        var name = /^<(\/?)\s*([a-z0-9:-]+)/i.exec(raw);
        if (name) out.push({ tag: name[1] + name[2].toLowerCase(), raw: raw, attrs: attrsOf(raw) });
      } else if (raw.trim()) out.push({ text: raw, raw: raw });
    }
    return out;
  }

  /** Поля внутри одного куска текста или значения атрибута: «{{price}} ₽», «Тур {{title}}». */
  function partMatch(templatePart, value, insideTag, fields) {
    var specs = [];
    var pattern = '';
    var last = 0;
    templatePart.replace(FIELD, function (whole, key, mode, offset) {
      pattern += escapeRegExp(templatePart.slice(last, offset)) + '([\\s\\S]*?)';
      specs.push({ key: key, mode: mode || '', insideTag: insideTag });
      last = offset + whole.length;
      return whole;
    });
    pattern += escapeRegExp(templatePart.slice(last));
    var found = new RegExp('^\\s*' + pattern + '\\s*$').exec(value);
    if (!found) return false;
    specs.forEach(function (spec, index) { if (!fields[spec.key]) fields[spec.key] = { raw: found[index + 1], spec: spec }; });
    return true;
  }

  function structureMatch(templateTokens, rowTokens) {
    var fields = {};
    var same = 0;
    var total = 0;
    var r = 0;
    for (var t = 0; t < templateTokens.length; t += 1) {
      var tok = templateTokens[t];
      if (tok.text != null) {
        var whole = WHOLE_FIELD.exec(tok.text);
        if (whole) {
          // Поле занимает весь текст: забираем текст вместе с <br>, <strong>, <span style> (абзацы, жирный,
          // оформление), пока не встретим тег, который в шаблоне идёт следом.
          var next = templateTokens[t + 1] && templateTokens[t + 1].tag;
          var raw = '';
          var depth = 0;
          while (r < rowTokens.length) {
            var row = rowTokens[r];
            if (row.tag != null) {
              if (!INLINE.test(row.tag)) break;
              var closing = row.tag.charAt(0) === '/';
              if (depth === 0 && row.tag === next) break;
              if (closing && depth === 0) break;
              if (row.tag !== 'br' && row.tag !== 'wbr') depth += closing ? -1 : 1;
            }
            raw += row.raw;
            r += 1;
          }
          if (!fields[whole[1]]) fields[whole[1]] = { raw: raw, spec: { key: whole[1], mode: whole[2] || '', insideTag: false } };
          continue;
        }
        var rowText = rowTokens[r] && rowTokens[r].text;
        if (/\{\{/.test(tok.text)) {
          if (rowText == null || !partMatch(tok.text, rowText, false, fields)) return null;
          r += 1;
          continue;
        }
        total += 1;
        if (rowText != null) { if (decodeEntities(rowText).trim() === decodeEntities(tok.text).trim()) same += 1; r += 1; }
        continue;
      }
      var rowTag = rowTokens[r];
      if (!rowTag || rowTag.tag !== tok.tag) return null;
      for (var name in tok.attrs) {
        if (!/\{\{/.test(tok.attrs[name])) continue;
        if (rowTag.attrs[name] == null || !partMatch(tok.attrs[name], rowTag.attrs[name], true, fields)) return null;
      }
      r += 1;
    }
    if (r !== rowTokens.length) return null;
    return { fields: fields, score: total ? same / total : 1, size: templateTokens.length };
  }

  function itemFrom(component, captured) {
    var fields = {};
    var formats = {};
    var invalid = false;
    Object.keys(captured).forEach(function (key) {
      var parsed = fieldValue(captured[key].raw, captured[key].spec);
      if (parsed.invalid) invalid = true;
      var def = ((component.fields || []).find(function (f) { return f.key === key; }) || {}).default;
      if (parsed.format) formats[key] = parsed.format;
      if (def != null && String(def) === parsed.value) return;
      if (parsed.value === '' && (def == null || def === '')) return;
      fields[key] = parsed.value;
    });
    if (invalid) return null;
    var item = { component: component.id, fields: fields };
    if (Object.keys(formats).length) item.formats = formats;
    return item;
  }

  function prepared(component, template) {
    var cached = matcherCache && matcherCache.get(component);
    if (cached && cached.template === template) return cached;
    var entry = { template: template, matcher: matcherFor(template), tokens: tokensOf(template) };
    if (matcherCache) matcherCache.set(component, entry);
    return entry;
  }

  /**
   * Кусок письма → { item, match: 'exact' | 'structure', score } или null. rows — сколько строк <tr em="block">
   * в куске: компонент может состоять из нескольких строк. Сначала буквальное совпадение с шаблоном, затем —
   * по структуре тегов (score — доля совпавшего неизменяемого текста шаблона, нужно не меньше 0.5).
   */
  function matchBlock(blockHtml, kit, rows) {
    // Удалённые из библиотеки (archived) не узнаём: их место заняли другие блоки, в новые письма они не идут.
    var components = ((kit.registry && kit.registry.components) || []).filter(function (component) { return !component.archived && kit.templates && kit.templates[component.id]; });
    var row = normalizeHtml(blockHtml);
    var best = null;
    components.forEach(function (component) {
      var entry = prepared(component, kit.templates[component.id]);
      if (rows && entry.matcher.rows !== rows) return;
      var found = entry.matcher.regex.exec(row);
      if (!found || (best && best.literal >= entry.matcher.literal)) return;
      var captured = {};
      entry.matcher.keys.forEach(function (spec, index) { if (!captured[spec.key]) captured[spec.key] = { raw: found[index + 1], spec: spec }; });
      var item = itemFrom(component, captured);
      if (item) best = { item: item, literal: entry.matcher.literal };
    });
    if (best) return { item: best.item, match: 'exact', score: 1 };
    var rowTokens = tokensOf(blockHtml);
    var similar = null;
    components.forEach(function (component) {
      var entry = prepared(component, kit.templates[component.id]);
      if (rows && entry.matcher.rows !== rows) return;
      var result = structureMatch(entry.tokens, rowTokens);
      if (!result || result.score < 0.5) return;
      if (similar && (result.score < similar.score || (result.score === similar.score && result.size <= similar.size))) return;
      var item = itemFrom(component, result.fields);
      if (item) similar = { item: item, score: result.score, size: result.size };
    });
    return similar ? { item: similar.item, match: 'structure', score: Math.round(similar.score * 100) / 100 } : null;
  }

  /**
   * Письмо целиком → { subject, preheader, utm, source, blocks: [{ index, html, item | null }] }.
   * item — элемент письма { component, fields, formats? }; null — блока нет в библиотеке (кандидат в новый компонент).
   * match: 'exact' — совпал с шаблоном буквально, 'structure' — по структуре (тексты взяты из письма), 'new' — не узнан.
   */
  function parseLetter(html, kit) {
    var text = String(html || '');
    var title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    var pre = /<div[^>]*class="[^"]*preheader[^"]*"[^>]*>([\s\S]*?)(?:<vk-snippet-end|<\/div>)/i.exec(text);
    var utm = { campaign: '', content: '' };
    text.replace(/\bhref\s*=\s*"([^"]*)"/gi, function (_, href) {
      try {
        var url = new URL(decodeAttr(href));
        if (!utm.campaign && url.searchParams.get('utm_campaign')) utm.campaign = url.searchParams.get('utm_campaign');
        if (!utm.content && url.searchParams.get('utm_content')) utm.content = url.searchParams.get('utm_content');
      } catch (e) { /* не абсолютная ссылка */ }
      return _;
    });
    var split = splitBlocks(text);
    var maxRows = 1;
    ((kit.registry && kit.registry.components) || []).forEach(function (component) {
      var template = kit.templates && kit.templates[component.id];
      if (template) maxRows = Math.max(maxRows, splitBlocks(template).blocks.length || 1);
    });
    // Жадно слева направо: на каждой позиции — самый длинный кусок из нескольких строк, который узнаётся.
    var blocks = [];
    for (var i = 0; i < split.blocks.length;) {
      var found = null;
      var size = 1;
      for (var rows = Math.min(maxRows, split.blocks.length - i); rows >= 1 && !found; rows -= 1) {
        found = matchBlock(split.blocks.slice(i, i + rows).join(''), kit, rows);
        if (found) size = rows;
      }
      blocks.push({ index: blocks.length, html: split.blocks.slice(i, i + size).join(''), item: found ? found.item : null, match: found ? found.match : 'new', score: found ? found.score : 0 });
      i += size;
    }
    return {
      subject: title ? decodeEntities(title[1].replace(/<[^>]+>/g, '')).trim() : '',
      preheader: pre ? decodeEntities(pre[1].replace(/<[^>]+>/g, '')).replace(/[͏‌ \s]+$/g, '').trim() : '',
      utm: utm,
      source: split.source,
      blocks: blocks,
    };
  }

  function tourFields(tour, fallbackCta) {
    var meta = [tour.dates, tour.price].filter(function (part) { return String(part || '').trim(); }).join(' · ');
    return {
      title: tour.name || '', route: tour.route || '', meta: meta, cta: tour.cta || fallbackCta || 'Узнать подробнее',
      url: tour.url || '', image: tour.image || '', alt: tour.alt || tour.name || '',
    };
  }

  function firstOf(registry, type) {
    var list = (registry && registry.components) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].type === type && !list[i].archived) return list[i].id;
    return null;
  }

  /**
   * Черновик состава по брифу — детерминированный рецепт. Агент начинает с него и правит по смыслу брифа;
   * страница показывает его сразу. Возвращает { items, notes, missing }.
   */
  function proposeFromBrief(brief, registry) {
    brief = brief || {};
    var items = [];
    var notes = [];
    var missing = [];
    var add = function (type, fields) {
      var id = firstOf(registry, type);
      if (id) items.push({ component: id, fields: fields || {} });
    };
    var kind = String(brief.type || 'подборка').toLowerCase();
    var tours = (brief.tours || []).filter(function (tour) { return tour && (tour.name || tour.url); });

    add('header');
    add('title', { title: brief.title || brief.subject || '' });
    if (String(brief.message || '').trim()) add('text', { text: brief.message });
    if (String(brief.promo_code || '').trim()) add('promo-code', { code: brief.promo_code });

    if (kind.indexOf('акци') >= 0) {
      if (brief.cta_url) add('primary-cta', { label: brief.cta || 'Подробнее', url: brief.cta_url });
      tours.forEach(function (tour, i) { add(i % 2 ? 'tour-card-right' : 'tour-card-left', tourFields(tour, brief.card_cta)); });
      notes.push('Одна акция: главный переход — кнопка сразу после текста' + (tours.length ? ', ниже — туры акции.' : '.'));
    } else if (kind.indexOf('дайджест') >= 0) {
      for (var p = 0; p < tours.length; p += 2) {
        var a = tourFields(tours[p], brief.card_cta);
        var b = tours[p + 1] ? tourFields(tours[p + 1], brief.card_cta) : null;
        if (b) add('tour-pair', { a_title: a.title, a_meta: a.meta, a_url: a.url, a_image: a.image, a_alt: a.alt, b_title: b.title, b_meta: b.meta, b_url: b.url, b_image: b.image, b_alt: b.alt });
        else add('tour-card-left', a);
      }
      if (brief.cta_url) add('primary-cta', { label: brief.cta || 'Все туры', url: brief.cta_url });
      notes.push('Дайджест: туры парами в ряд, общий переход в конце.');
    } else {
      if (brief.cta_url) add('primary-cta', { label: brief.cta || 'Смотреть туры', url: brief.cta_url });
      if (tours.length) {
        add('divider');
        add('section-title', { title: brief.section_title || 'Туры подборки' });
        tours.forEach(function (tour, i) { add(i % 2 ? 'tour-card-right' : 'tour-card-left', tourFields(tour, brief.card_cta)); });
        add('divider');
      }
      add('catalog-banner');
      notes.push('Подборка: карточки туров чередуются (фото слева/справа), в конце баннер каталога.');
    }
    add('footer');

    if (!String(brief.subject || '').trim()) missing.push('тема письма');
    if (!String(brief.utm_campaign || '').trim()) missing.push('UTM-кампания');
    if (!String(brief.utm_content || '').trim()) missing.push('utm_content (например, дата выпуска ddmmyy)');
    tours.forEach(function (tour, i) {
      ['url', 'image'].forEach(function (key) { if (!String(tour[key] || '').trim()) missing.push('тур ' + (i + 1) + ': ' + (key === 'url' ? 'ссылка' : 'картинка')); });
    });
    return { items: items, notes: notes, missing: missing };
  }

  function newLetter(id, brief) {
    return {
      id: id,
      version: 2,
      status: 'brief',
      updated_at: new Date().toISOString(),
      brief: brief || { type: 'подборка', subject: '', preheader: '', message: '', cta: '', cta_url: '', promo_code: '', utm_campaign: '', utm_content: '', extra: '', tours: [] },
      letter: { subject: '', preheader: '', utm: { campaign: '', content: '' }, items: [] },
      proposal: null,
      check: null,
    };
  }

  root.LetterKit = {
    version: 2,
    MARK: MARK,
    escapeHtml: escapeHtml,
    richText: richText,
    normalizeFormat: normalizeFormat,
    templateFields: templateFields,
    componentById: componentById,
    renderComponent: renderComponent,
    renderLetter: renderLetter,
    applyUtm: applyUtm,
    proposeFromBrief: proposeFromBrief,
    newLetter: newLetter,
    splitBlocks: splitBlocks,
    matchBlock: matchBlock,
    parseLetter: parseLetter,
    normalizeHtml: normalizeHtml,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
