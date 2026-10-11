import { useRef, useState } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import { fetchJson } from "../../lib/api";

export type ItemKind = "skill" | "tool";

function hashOf(text: string) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash;
}

/** Две буквы для плитки без картинки: «SEO Wizard» → SW, «mbox-api» → MA, «Топвизор» → ТО. */
function initials(name: string) {
  const words = name.split(/[\s\-_/]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] || "?").slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Значок навыка или API: своя картинка либо плитка со скруглением «как у приложения» и инициалами на цветном фоне.
 * Цвет берётся из названия, поэтому у одного и того же навыка он везде одинаковый.
 */
export function ItemIcon({ icon, name, size = 56 }: { icon?: string; name: string; size?: number }) {
  const hue = hashOf(name) % 360;
  const style = {
    width: size,
    height: size,
    ["--icon-hue" as string]: hue,
    fontSize: Math.round(size * 0.36),
  };
  return icon
    ? <img className="item-icon" src={icon} alt="" width={size} height={size} style={style} draggable={false} />
    : <span className="item-icon is-generated" style={style} aria-hidden="true">{initials(name)}</span>;
}

/** Картинка → квадрат 160×160 PNG data:-ссылкой (обрезка по центру), чтобы значок весил несколько килобайт. */
async function toSquareDataUrl(file: File, side = 160): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  const crop = Math.min(bitmap.width, bitmap.height);
  context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

/** Кнопки «Свой значок» и «Сбросить»: сохраняют значок на сервере и сообщают наверх, что поменялось. */
export function IconControls({ kind, refId, hasIcon, onChanged }: { kind: ItemKind; refId: string; hasIcon: boolean; onChanged: (icon: string) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = await toSquareDataUrl(file);
      await fetchJson(`/api/mbox/icons/${kind}/${refId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data_url: dataUrl }) });
      onChanged(dataUrl);
    } catch { setError("Не получилось: нужна картинка PNG, JPEG или WebP."); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  }

  async function reset() {
    setBusy(true);
    setError("");
    try {
      await fetchJson(`/api/mbox/icons/${kind}/${refId}`, { method: "DELETE" });
      onChanged("");
    } catch { setError("Не удалось сбросить значок."); }
    finally { setBusy(false); }
  }

  return (
    <span className="icon-controls">
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void pick(event.target.files?.[0])} />
      <button className="ghost-action" type="button" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={14} /> Свой значок</button>
      {hasIcon && <button className="ghost-action" type="button" disabled={busy} onClick={() => void reset()}><RotateCcw size={14} /> Сбросить</button>}
      {error && <small className="account-error" role="alert">{error}</small>}
    </span>
  );
}
