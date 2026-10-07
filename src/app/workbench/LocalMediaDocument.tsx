import { useEffect, useRef, useState } from "react";
import { ExternalLink, FolderOpen, RefreshCw } from "lucide-react";
import { AUDIO_FILE, gitStatusOf, onWorkspaceChange, rootName, workspaceBridge } from "./localWorkspace";
import { gitLetter } from "./LocalFolders";
import { useRemembered } from "./uiMemory";

const RATES = [0.75, 1, 1.25, 1.5, 2];

type Memory = { time: number; rate: number; volume: number };

function clock(seconds: number) {
  if (!Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Видео и аудио из локальной папки. Файл отдаёт главный процесс по mbox-media:// потоком (перемотка
 * без чтения целиком). Для каждого файла запоминаются место, скорость и громкость — открыл видео снова,
 * и оно продолжается там, где остановился. Что Chromium не играет (avi, wmv, часть mkv), открывается
 * системным плеером.
 */
export function LocalMediaDocument({ rootKey, path }: { rootKey: string; path: string }) {
  const bridge = workspaceBridge();
  const audio = AUDIO_FILE.test(path);
  const [memory, setMemory] = useRemembered<Memory>(`media:${rootKey}:${path}`, { time: 0, rate: 1, volume: 1 });
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const [meta, setMeta] = useState<{ width: number; height: number; duration: number } | null>(null);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const savedAt = useRef(0);

  useEffect(() => { setFailed(false); setMeta(null); }, [rootKey, path, version]);
  // Файл перезаписали на диске (перекодировали, докачали) — перечитываем, сохранив место.
  useEffect(() => onWorkspaceChange((key, paths) => { if (key === rootKey && paths.includes(path)) setVersion((v) => v + 1); }), [rootKey, path]);

  if (!bridge) return <div className="wb-doc-missing">Локальные файлы открываются в MBOX Desktop.</div>;

  const src = bridge.mediaUrl ? `${bridge.mediaUrl(rootKey, path)}${version ? `?v=${version}` : ""}` : "";
  const letter = gitLetter(gitStatusOf(rootKey, path));
  const openExternal = () => void bridge.openDefault(rootKey, path);

  const remember = (patch: Partial<Memory>) => setMemory((current) => ({ ...current, ...patch }));
  const onTime = () => {
    const el = mediaRef.current;
    if (!el) return;
    const now = Date.now();
    if (now - savedAt.current < 2000) return;
    savedAt.current = now;
    // Досмотрели почти до конца — в следующий раз с начала.
    remember({ time: el.duration && el.duration - el.currentTime < 5 ? 0 : el.currentTime });
  };

  return (
    <div className="wb-media-doc">
      <div className="wb-doc-bar">
        <span className="wb-doc-crumbs">{rootName(rootKey)} › {path.split("/").join(" › ")}{letter && <span className={`wb-git-letter is-${letter}`}>{letter}</span>}</span>
        <div className="wb-doc-actions">
          {!failed && src && (
            <div className="wb-segmented" title="Скорость воспроизведения">
              {RATES.map((rate) => (
                <button key={rate} type="button" className={memory.rate === rate ? "is-on" : undefined} onClick={() => { remember({ rate }); if (mediaRef.current) mediaRef.current.playbackRate = rate; }}>
                  {rate}×
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setVersion((v) => v + 1)} title="Перечитать с диска"><RefreshCw size={13} /></button>
          <button type="button" onClick={openExternal} title="Открыть в системном плеере"><ExternalLink size={13} /></button>
          <button type="button" onClick={() => void bridge.reveal(rootKey, path)} title="Показать в проводнике Windows"><FolderOpen size={13} /></button>
        </div>
      </div>
      {meta && (
        <div className="wb-meta-strip">
          {!audio && meta.width > 0 && <span>{meta.width} × {meta.height}</span>}
          {meta.duration > 0 && <span>{clock(meta.duration)}</span>}
          <span>{path.split(".").pop()?.toUpperCase()}</span>
        </div>
      )}
      {!src || failed ? (
        <div className="wb-doc-missing wb-media-fallback">
          <p>{!src
            ? "Эта версия MBOX Desktop ещё не показывает видео — обновите приложение или откройте файл системным плеером."
            : "Встроенный плеер не воспроизводит этот формат или кодек (обычно AVI, WMV, часть MKV)."}</p>
          <button type="button" className="primary-action" onClick={openExternal}><ExternalLink size={14} /> Открыть в системном плеере</button>
        </div>
      ) : (
        <div className={audio ? "wb-media-stage is-audio" : "wb-media-stage"}>
          {audio ? (
            <audio
              key={src}
              ref={mediaRef}
              src={src}
              controls
              preload="metadata"
              onLoadedMetadata={(event) => {
                const el = event.currentTarget;
                setMeta({ width: 0, height: 0, duration: el.duration });
                el.playbackRate = memory.rate;
                el.volume = memory.volume;
                if (memory.time > 0 && memory.time < el.duration) el.currentTime = memory.time;
              }}
              onTimeUpdate={onTime}
              onPause={(event) => remember({ time: event.currentTarget.currentTime })}
              onVolumeChange={(event) => remember({ volume: event.currentTarget.volume })}
              onError={() => setFailed(true)}
            />
          ) : (
            <video
              key={src}
              ref={mediaRef}
              src={src}
              controls
              playsInline
              preload="metadata"
              onLoadedMetadata={(event) => {
                const el = event.currentTarget;
                // Контейнер открылся, а видеодорожку декодер не понял (HEVC в mov/mkv) — ширина 0.
                if (!el.videoWidth && !el.duration) { setFailed(true); return; }
                setMeta({ width: el.videoWidth, height: el.videoHeight, duration: el.duration });
                el.playbackRate = memory.rate;
                el.volume = memory.volume;
                if (memory.time > 0 && memory.time < el.duration) el.currentTime = memory.time;
              }}
              onTimeUpdate={onTime}
              onPause={(event) => remember({ time: event.currentTarget.currentTime })}
              onVolumeChange={(event) => remember({ volume: event.currentTarget.volume })}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}
