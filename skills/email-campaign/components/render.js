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

  function tourFields(tour, fallbackCta) {
    var meta = [tour.dates, tour.price].filter(function (part) { return String(part || '').trim(); }).join(' · ');
    return {
      title: tour.name || '', route: tour.route || '', meta: meta, cta: tour.cta || fallbackCta || 'Узнать подробнее',
      url: tour.url || '', image: tour.image || '', alt: tour.alt || tour.name || '',
    };
  }

  function firstOf(registry, type) {
    var list = (registry && registry.components) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].type === type) return list[i].id;
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
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
