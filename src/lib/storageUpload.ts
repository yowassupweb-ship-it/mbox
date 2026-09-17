/**
 * Загрузка файла в S3 MBOX: напрямую в бакет по подписанной ссылке (настоящий прогресс), а если бакет не
 * пускает — через сервер. Используют хранилище (Storage.tsx) и картинки в заметках (MarkdownToolbar).
 */
export type UploadMode = "direct" | "proxy";

async function directUploadUrl(key: string) {
  try {
    const response = await fetch("/api/mbox/storage/upload-url", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
    if (!response.ok) return null;
    return ((await response.json()) as { url: string }).url;
  } catch {
    return null;
  }
}

function putWithProgress(url: string, file: Blob, onProgress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Хранилище ответило ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("direct-network"));
    xhr.send(file);
  });
}

function proxyUpload(key: string, file: Blob, onProgress: (loaded: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/mbox/storage/upload?key=${encodeURIComponent(key)}`);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        try { reject(new Error(JSON.parse(xhr.responseText).error)); } catch { reject(new Error(`Ошибка ${xhr.status}`)); }
      }
    };
    xhr.onerror = () => reject(new Error("Сеть оборвалась"));
    xhr.send(file);
  });
}

export async function uploadToStorage(key: string, file: Blob, onProgress: (loaded: number, mode: UploadMode) => void = () => undefined) {
  const url = await directUploadUrl(key);
  if (url) {
    let sent = 0;
    try {
      await putWithProgress(url, file, (loaded) => { sent = loaded; onProgress(loaded, "direct"); });
      return;
    } catch (error) {
      // CORS или сеть до первого байта — пробуем через сервер; оборвалось на середине — это настоящая ошибка.
      if (sent > 0 || !(error instanceof Error && error.message === "direct-network")) throw error;
    }
  }
  onProgress(0, "proxy");
  await proxyUpload(key, file, (loaded) => onProgress(loaded, "proxy"));
}

/** Постоянная ссылка на объект: сервер каждый раз отдаёт свежую подписанную ссылку (302). */
export const storageFileUrl = (key: string) => `/api/mbox/storage/file?key=${encodeURIComponent(key)}`;
