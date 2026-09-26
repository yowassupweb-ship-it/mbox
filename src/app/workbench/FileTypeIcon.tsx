/**
 * Значки файлов и папок из Material Icon Theme — того же набора, что стоит по умолчанию у большинства
 * в VS Code: у каждого языка и формата свой узнаваемый значок вместо одного глифа разного цвета.
 * В сборку попадают только перечисленные здесь SVG (мелкие Vite встраивает data-URI).
 */
const ICONS = import.meta.glob(
  "../../../node_modules/material-icon-theme/icons/{typescript,javascript,react_ts,react,python,markdown,json,html,css,sass,document,pdf,word,table,powerpoint,image,video,audio,zip,database,settings,yaml,xml,console,git,docker,lock,key,email,url,file,svg,log,toml,rust,go,java,c,cpp,csharp,php,ruby,kotlin,swift,vue,svelte,lua,powershell,readme,tune,certificate,license,changelog,makefile,nodejs,npm,tsconfig,vite,font,exe,http,todo,folder,folder-open}.svg",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

const icon = (name: string) => ICONS[`../../../node_modules/material-icon-theme/icons/${name}.svg`] ?? ICONS["../../../node_modules/material-icon-theme/icons/file.svg"];

const BY_NAME: Array<[RegExp, string]> = [
  [/^readme(\.|$)/i, "readme"],
  [/^(license|licence|copying)(\.|$)/i, "license"],
  [/^(changelog|changes|history)(\.md)?$/i, "changelog"],
  [/^todo(\.|$)/i, "todo"],
  [/^(dockerfile|docker-compose.*\.ya?ml|compose\.ya?ml)$/i, "docker"],
  [/^makefile$/i, "makefile"],
  [/^\.git(ignore|attributes|modules|keep)$/i, "git"],
  [/^\.env(\.|$)/i, "tune"],
  [/^package(-lock)?\.json$/i, "npm"],
  [/^tsconfig.*\.json$/i, "tsconfig"],
  [/^vite\.config\.[cm]?[jt]s$/i, "vite"],
  [/^\.?(nvmrc|node-version)$/i, "nodejs"],
];

const BY_EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "react_ts", jsx: "react",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyw: "python", ipynb: "python",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  json: "json", jsonc: "json", geojson: "json",
  html: "html", htm: "html",
  css: "css", scss: "sass", sass: "sass", less: "css",
  txt: "document", rtf: "document", odt: "word", pages: "document",
  pdf: "pdf",
  doc: "word", docx: "word",
  xls: "table", xlsx: "table", xlsm: "table", ods: "table", csv: "table", tsv: "table", numbers: "table",
  ppt: "powerpoint", pptx: "powerpoint", odp: "powerpoint", key: "powerpoint",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", ico: "image", avif: "image", tif: "image", tiff: "image", heic: "image",
  svg: "svg",
  mp4: "video", mov: "video", mkv: "video", webm: "video", avi: "video", m4v: "video", wmv: "video", mpeg: "video", mpg: "video",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio", opus: "audio", wma: "audio", aiff: "audio",
  zip: "zip", rar: "zip", "7z": "zip", tar: "zip", gz: "zip", tgz: "zip", bz2: "zip", xz: "zip", cab: "zip", iso: "zip", dmg: "zip",
  db: "database", sqlite: "database", sqlite3: "database", sql: "database", parquet: "database", avro: "database",
  ini: "settings", cfg: "settings", conf: "settings", config: "settings", properties: "settings",
  env: "tune",
  yaml: "yaml", yml: "yaml", toml: "toml", lock: "lock",
  xml: "xml", plist: "xml",
  sh: "console", bash: "console", zsh: "console", fish: "console", bat: "console", cmd: "console",
  ps1: "powershell", psm1: "powershell",
  pem: "certificate", crt: "certificate", cer: "certificate", pfx: "certificate", p12: "certificate",
  pub: "key", asc: "key", gpg: "key",
  eml: "email", msg: "email", mbox: "email",
  url: "url", webloc: "url", lnk: "url",
  http: "http", rest: "http",
  log: "log",
  rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", rb: "ruby", lua: "lua", vue: "vue", svelte: "svelte",
  ttf: "font", otf: "font", woff: "font", woff2: "font",
  exe: "exe", msi: "exe",
};

function baseName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

export function fileIconUrl(name: string): string {
  const base = baseName(name);
  for (const [pattern, iconName] of BY_NAME) if (pattern.test(base)) return icon(iconName);
  const ext = base.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return icon(BY_EXT[ext] ?? "file");
}

export function FileTypeIcon({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  return <img className={`wb-file-type-icon ${className}`.trim()} src={fileIconUrl(name)} width={size} height={size} alt="" draggable={false} />;
}

export function FolderIcon({ open = false, size = 18, className = "" }: { open?: boolean; size?: number; className?: string }) {
  return <img className={`wb-folder-icon ${className}`.trim()} src={icon(open ? "folder-open" : "folder")} width={size} height={size} alt="" draggable={false} />;
}
