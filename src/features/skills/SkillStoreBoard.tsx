import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Search, Store } from "lucide-react";
import { ApiError, fetchJson } from "../../lib/api";
import { EmptyState } from "../../ui";
import { askConfirm } from "../../ui/askText";
import { IconControls, ItemIcon, type ItemKind } from "./ItemIcon";

type Item = { id: string; kind: ItemKind; ref: string; title: string; summary: string; publisher: string; installs: number; installed: boolean; mine: boolean; icon: string };
type Mine = { id: string; label: string; hint: string; icon: string };

const JSON_HEADERS = { "content-type": "application/json" };
const KIND_TITLE: Record<ItemKind, string> = { skill: "Навыки", tool: "Инструменты" };

function installsLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? "установка" : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? "установки" : "установок";
  return `${count} ${word}`;
}

function PublishForm({ kind, items, onPublished }: { kind: ItemKind; items: Item[]; onPublished: (items: Item[]) => void }) {
  const [mine, setMine] = useState<Mine[]>([]);
  const [ref, setRef] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      if (kind === "skill") {
        const result = await fetchJson<{ skills: Array<{ id: string; name: string; summary: string; icon: string; own: boolean }> }>("/api/mbox/admin/skills");
        setMine(result.skills.filter((skill) => skill.own).map((skill) => ({ id: skill.id, label: skill.name, hint: skill.summary, icon: skill.icon })));
      } else {
        const result = await fetchJson<{ integrations: Array<{ service: string; label: string; kind: string; hint?: string; icon?: string }> }>("/api/mbox/integrations");
        setMine(result.integrations.filter((tool) => tool.kind === "custom").map((tool) => ({ id: tool.service, label: tool.label, hint: tool.hint || "", icon: tool.icon || "" })));
      }
    } catch { setMine([]); }
  }, [kind]);
  useEffect(() => { setRef(""); void load(); }, [load]);

  const published = new Set(items.filter((item) => item.mine && item.kind === kind).map((item) => item.ref));
  const options = mine.filter((option) => !published.has(option.id));
  const picked = options.find((option) => option.id === ref) || options[0];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const result = await fetchJson<{ items: Item[] }>("/api/mbox/store", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind, ref: picked.id, title: picked.label, summary: summary || picked.hint }) });
      onPublished(result.items);
      setSummary("");
      void load();
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 409 ? "Этот код уже опубликован другим человеком." : "Не удалось опубликовать.");
    } finally { setBusy(false); }
  }

  if (!options.length) {
    return <p className="store-publish-empty">{kind === "skill" ? "Нет своих неопубликованных навыков. Создайте навык в «Настройки → Мои навыки» или попросите агента." : "Нет своих неопубликованных API. Подключите своё API в разделе «Инструменты»."}</p>;
  }

  return (
    <form className="store-publish" onSubmit={submit}>
      <div className="store-publish-icon">
        <ItemIcon icon={picked?.icon} name={picked?.label || ""} size={72} />
        {picked && <IconControls kind={kind} refId={picked.id} hasIcon={Boolean(picked.icon)} onChanged={(icon) => setMine((current) => current.map((item) => (item.id === picked.id ? { ...item, icon } : item)))} />}
      </div>
      <div className="store-publish-fields">
        <select value={picked?.id || ""} onChange={(event) => setRef(event.target.value)} aria-label={kind === "skill" ? "Какой навык" : "Какое API"}>
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
        <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={picked?.hint || "Для чего это (по желанию)"} aria-label="Описание для витрины" />
        {kind === "tool" && <p className="integration-hint">Публикуется только шаблон: адрес и способ входа. Ключ остаётся у вас, каждый вносит свой.</p>}
        {error && <div className="account-error" role="alert">{error}</div>}
        <button className="primary-action" type="submit" disabled={busy}>{busy ? "Публикую…" : "Опубликовать"}</button>
      </div>
    </form>
  );
}

function AppRow({ item, busy, onAct }: { item: Item; busy: boolean; onAct: (item: Item, method: "POST" | "DELETE", suffix: "/install" | "") => void }) {
  async function unpublish() {
    const ok = await askConfirm({ title: `Убрать «${item.title}» из магазина?`, message: "Коллеги больше не смогут его поставить. У вас и у тех, кто уже поставил, он останется.", confirmLabel: "Убрать из магазина" });
    if (ok) onAct(item, "DELETE", "");
  }
  async function uninstall() {
    const ok = await askConfirm({ title: `Удалить «${item.title}» у себя?`, message: item.kind === "skill" ? "Навык пропадёт у вас и у ваших агентов. Поставить снова можно здесь же." : "Подключение и ваши ключи к нему удалятся. Поставить снова можно здесь же.", confirmLabel: "Удалить у себя" });
    if (ok) onAct(item, "DELETE", "/install");
  }
  return (
    <article className="store-app">
      <ItemIcon icon={item.icon} name={item.title} size={64} />
      <div className="store-app-text">
        <strong>{item.title}</strong>
        <span className="store-app-summary">{item.summary || (item.kind === "skill" ? "Навык для агентов" : "Подключение к API")}</span>
        <small>
          {item.mine ? "Вы автор" : item.publisher} · {installsLabel(item.installs)}
          {item.mine && <> · <button className="store-link" type="button" disabled={busy} onClick={() => void unpublish()}>Убрать из магазина</button></>}
        </small>
      </div>
      {/* Своё у автора уже есть — ставить нечего, поэтому кнопки «Получить» нет. Убрать из магазина — отдельной ссылкой с подтверждением. */}
      {item.mine
        ? <span className="store-get is-quiet is-static" title="Ваш навык уже есть у вас и у ваших агентов">Есть у вас</span>
        : item.installed
          ? <button className="store-get is-quiet" type="button" disabled={busy} onClick={() => void uninstall()} title="Удалить у себя">Установлено</button>
          : <button className="store-get" type="button" disabled={busy} onClick={() => onAct(item, "POST", "/install")}>Получить</button>}
    </article>
  );
}

/**
 * Магазин навыков и инструментов (API). Витрина как в App Store: значок, название, одна строка о том, что это, кнопка «Получить».
 * Навык после установки появляется у человека и его агентов, API — в разделе «Инструменты» с пустым ключом.
 */
export function SkillStoreBoard() {
  const [items, setItems] = useState<Item[]>([]);
  const [kind, setKind] = useState<ItemKind>("skill");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await fetchJson<{ items: Item[] }>("/api/mbox/store")).items); }
    catch { setError("Не удалось загрузить магазин."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(item: Item, method: "POST" | "DELETE", suffix: "/install" | "") {
    setBusy(item.id);
    setError("");
    try {
      setItems((await fetchJson<{ items: Item[] }>(`/api/mbox/store/${item.id}${suffix}`, { method })).items);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.code === "install_failed" ? "Не удалось установить: проверьте адрес API." : "Не удалось выполнить действие.");
    } finally { setBusy(""); }
  }

  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => items.filter((item) => item.kind === kind && (!needle || `${item.title} ${item.summary} ${item.publisher}`.toLowerCase().includes(needle))), [items, kind, needle]);
  const counts = useMemo(() => ({ skill: items.filter((item) => item.kind === "skill").length, tool: items.filter((item) => item.kind === "tool").length }), [items]);

  return (
    <div className="store">
      <header className="store-head">
        <div>
          <h1>Магазин</h1>
          <p>{kind === "skill" ? "Навык — инструкция для агента. Ставится одним нажатием и сразу доступен вашим агентам." : "Инструмент — подключение к API. Ставится с пустым ключом, ключ вы вносите свой."}</p>
        </div>
        <button className="store-publish-toggle" type="button" aria-expanded={publishing} onClick={() => setPublishing((value) => !value)}><Store size={15} /> Опубликовать своё</button>
      </header>
      <div className="store-toolbar">
        <div className="store-tabs" role="tablist" aria-label="Что показывать">
          {(["skill", "tool"] as ItemKind[]).map((value) => (
            <button key={value} role="tab" type="button" aria-selected={kind === value} className={kind === value ? "is-active" : ""} onClick={() => setKind(value)}>
              {KIND_TITLE[value]}{counts[value] > 0 && <b>{counts[value]}</b>}
            </button>
          ))}
        </div>
        <label className="store-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти" aria-label="Найти в магазине" /></label>
      </div>
      {publishing && <section className="store-publish-panel" aria-label="Опубликовать своё"><PublishForm kind={kind} items={items} onPublished={(next) => { setItems(next); }} /></section>}
      {error && <p className="account-error" role="alert">{error}</p>}
      <div className="store-list">
        {visible.map((item) => <AppRow key={item.id} item={item} busy={busy === item.id} onAct={(target, method, suffix) => void act(target, method, suffix)} />)}
        {!visible.length && !error && <EmptyState text={needle ? "Ничего не найдено." : kind === "skill" ? "Навыков в магазине пока нет. Опубликуйте первый." : "Инструментов в магазине пока нет. Опубликуйте своё API."} />}
      </div>
    </div>
  );
}
