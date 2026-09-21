import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileKey2,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Link2,
  Mail,
  Presentation,
  type LucideIcon,
} from "lucide-react";

type FileVisual = {
  icon: LucideIcon;
  tone: "archive" | "audio" | "code" | "config" | "data" | "document" | "image" | "link" | "mail" | "presentation" | "security" | "sheet" | "video" | "generic";
};

const extensionOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/** Иконки файлов из lucide-react: один полный набор вместо случайных PNG и generic-document. */
export function fileVisual(name: string): FileVisual {
  const ext = extensionOf(name);
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|cab|iso|dmg)$/.test(ext)) return { icon: FileArchive, tone: "archive" };
  if (/^(mp3|wav|flac|m4a|aac|ogg|opus|wma|aiff)$/.test(ext)) return { icon: FileAudio, tone: "audio" };
  if (/^(mp4|mov|mkv|webm|avi|m4v|wmv|mpeg|mpg)$/.test(ext)) return { icon: FileVideo, tone: "video" };
  if (/^(png|jpe?g|gif|webp|bmp|ico|avif|svg|tiff?|heic)$/.test(ext)) return { icon: FileImage, tone: "image" };
  if (/^(csv|tsv|xls|xlsx|xlsm|ods|numbers)$/.test(ext)) return { icon: FileSpreadsheet, tone: "sheet" };
  if (/^(ppt|pptx|key|odp)$/.test(ext)) return { icon: Presentation, tone: "presentation" };
  if (/^(json|jsonc|geojson|ipynb)$/.test(ext)) return { icon: FileJson2, tone: "data" };
  if (/^(db|sqlite|sqlite3|sql|parquet|avro)$/.test(ext)) return { icon: Database, tone: "data" };
  if (/^(env|ini|cfg|conf|config|toml|yaml|yml|properties|lock)$/.test(ext) || /^\.env(?:\.|$)/i.test(name)) return { icon: FileCog, tone: "config" };
  if (/^(pem|crt|cer|pfx|p12|key|pub|asc|gpg)$/.test(ext)) return { icon: FileKey2, tone: "security" };
  if (/^(eml|msg|mbox)$/.test(ext)) return { icon: Mail, tone: "mail" };
  if (/^(url|webloc|lnk)$/.test(ext)) return { icon: Link2, tone: "link" };
  if (/^(js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|html?|vue|svelte|py|rb|php|java|kt|kts|swift|go|rs|c|cc|cpp|h|hpp|cs|fs|fsx|sh|bash|zsh|fish|ps1|bat|cmd|xml|graphql|gql|proto|dockerfile)$/.test(ext) || /^(dockerfile|makefile)$/i.test(name)) return { icon: FileCode2, tone: "code" };
  if (/^(md|mdx|markdown|txt|rtf|doc|docx|odt|pages|pdf|log)$/.test(ext)) return { icon: FileText, tone: "document" };
  return { icon: File, tone: "generic" };
}

export function FileTypeIcon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
  const visual = fileVisual(name);
  const Icon = visual.icon;
  return <Icon className={`wb-file-type-icon is-${visual.tone} ${className}`.trim()} width={size} height={size} strokeWidth={1.7} aria-hidden="true" />;
}
