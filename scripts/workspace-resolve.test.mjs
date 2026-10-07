import assert from "node:assert/strict";
import test from "node:test";
import { pickWorkspace } from "./workspace-resolve.mjs";

const WS = [
  { id: "1", name: "Вокруг света", root_path: "C:\\Users\\a\\Documents\\Вокруг света" },
  { id: "2", name: "Mbox", root_path: "C:\\Users\\a\\Desktop\\Mbox" },
  { id: "3", name: "Mbox work", root_path: "C:\\Users\\a\\Desktop\\Mbox\\work" },
];
const ONE = [WS[0]];

test("точное имя и id работают как раньше", () => {
  assert.equal(pickWorkspace(WS, "mbox", "a/b.txt").workspace.id, "2");
  assert.equal(pickWorkspace(WS, "1", "a.txt").workspace.name, "Вокруг света");
});

test("единственная папка подставляется сама", () => {
  assert.deepEqual(pickWorkspace(ONE, "", "Маршруты/1183.html").path, "Маршруты/1183.html");
});

test("абсолютный путь находит папку и режется до относительного, самый длинный корень побеждает", () => {
  const hit = pickWorkspace(WS, "", "C:\\Users\\a\\Desktop\\Mbox\\work\\notes\\x.md");
  assert.equal(hit.workspace.id, "3");
  assert.equal(hit.path, "notes/x.md");
  const outer = pickWorkspace(WS, "", "c:/users/a/desktop/mbox/memora/CLAUDE.md");
  assert.equal(outer.workspace.id, "2");
  assert.equal(outer.path, "memora/CLAUDE.md");
});

test("абсолютный путь в параметре workspace тоже понимается", () => {
  const hit = pickWorkspace(WS, "C:\\Users\\a\\Documents\\Вокруг света\\Маршруты", "1183.html");
  assert.equal(hit.workspace.id, "1");
  assert.equal(hit.path, "Маршруты/1183.html");
});

test("«Имя/подпапка/файл» без workspace", () => {
  const hit = pickWorkspace(WS, "", "Вокруг света/Маршруты/1183.html");
  assert.equal(hit.workspace.id, "1");
  assert.equal(hit.path, "Маршруты/1183.html");
});

test("часть имени, если она одна", () => {
  assert.equal(pickWorkspace(WS, "вокруг", "a.txt").workspace.id, "1");
});

test("неоднозначное имя и чужой путь дают ошибку со списком папок и их путей", () => {
  assert.throws(() => pickWorkspace(WS, "mbo", "a"), /нескольким папкам.*#2 Mbox \(C:\\Users\\a\\Desktop\\Mbox\)/s);
  assert.throws(() => pickWorkspace(WS, "", "D:\\other\\a.txt"), /не лежит ни в одной.*#1 Вокруг света/s);
  assert.throws(() => pickWorkspace(WS, "", "a.txt"), /Не понял, какая папка.*#3 Mbox work/s);
});

test("запрос поиска не трогается", () => {
  const hit = pickWorkspace(ONE, "", "C:\\что-то\\query", { pathIsQuery: true });
  assert.equal(hit.path, "C:\\что-то\\query");
});
