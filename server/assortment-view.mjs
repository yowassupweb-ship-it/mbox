// Состав отчёта: что показывать, а что скрыть. Нужен для отчётов сотрудникам — им отдают цифры,
// а решения «что снять» остаются у владельца. Один выключатель, одно место применения: и экран,
// и страница по ссылке, и выгрузка в Excel спрашивают состав здесь, чтобы нигде не разъехалось.
import { NEUTRAL_STATUS_LABELS } from "./assortment-performance.mjs";

/** По умолчанию видно всё: это отчёт владельца. */
export const DEFAULT_VIEW = { advice: true };

export const normalizeView = (view) => ({ advice: view?.advice !== false });

/**
 * Данные отчёта без рекомендаций: уходят «что делать», кандидаты на снятие и советы по группам,
 * остаются факты — продажи, заполнение, конфликты, направления, сезонность.
 * Данные не портятся: функция возвращает копию.
 */
export function applyView(data, viewIn) {
  const view = normalizeView(viewIn);
  if (view.advice) return { ...data, view };
  const out = structuredClone(data);
  out.view = view;
  out.actions = [];
  out.insights = (out.insights || []).filter((i) => !i.advice);
  for (const k of out.clusters || []) if (k.advice) { k.advice.drop = []; k.advice.note = ""; }
  for (const g of out.variants || []) if (g.advice) { g.advice.drop = []; g.advice.note = ""; }
  for (const d of out.directions || []) d.cut = [];
  if (out.performance) {
    // «Убрать из продажи» — это уже решение. Сотрудник видит то же самое как факт: продаж нет, даты впереди стоят.
    out.performance.status_labels = NEUTRAL_STATUS_LABELS;
    out.performance.remove = [];
  }
  return out;
}

/** Какие листы выгрузки доступны при этом составе: рекомендательные уходят целиком. */
export const sheetAllowed = (sheet, viewIn) => normalizeView(viewIn).advice || !sheet.advice;
