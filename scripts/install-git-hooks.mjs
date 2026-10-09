// Включает хуки репозитория: git config core.hooksPath scripts/git-hooks. Запуск: node scripts/install-git-hooks.mjs
import { execFileSync } from "node:child_process";

execFileSync("git", ["config", "core.hooksPath", "scripts/git-hooks"], { stdio: "inherit" });
console.log("Готово: post-commit будет сообщать MBOX о коммитах с #N. Нужен MBOX_TOKEN в окружении.");
