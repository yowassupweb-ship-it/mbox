const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test, after } = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mbox-browser-import-"));
const previousLocal = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = root;
const userData = path.join(root, "MBOX");
fs.mkdirSync(userData);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return {
    app: { getPath: (name) => name === "userData" ? userData : root },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value, "utf8").subarray(0).reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
    },
  };
  return originalLoad(request, parent, isMain);
};
const imported = require("./import-chrome");
Module._load = originalLoad;

after(() => {
  if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocal;
  fs.rmSync(root, { recursive: true, force: true });
});

test("imports Chrome bookmark bar and folders, preserving local bookmarks", () => {
  const profile = path.join(root, "Google", "Chrome", "User Data", "Default");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "Bookmarks"), JSON.stringify({ roots: {
    bookmark_bar: { type: "folder", name: "Bookmarks bar", children: [
      { type: "url", name: "Example", url: "https://example.com/" },
      { type: "folder", name: "Work", children: [{ type: "url", name: "Docs", url: "https://docs.example.com/" }] },
      { type: "url", name: "Local", url: "file:///etc/passwd" },
    ] },
  } }));
  imported.setBookmark({ title: "Mine", url: "https://mine.example/" });
  assert.deepEqual(imported.chromeProfiles(), ["Default"]);
  const result = imported.importFromChrome({ bookmarks: true, history: false });
  assert.equal(result.bookmarks.count, 2);
  const items = imported.getBookmarks();
  assert.equal(items.length, 3);
  assert.equal(items.find((item) => item.title === "Docs").folder, "Work");
  assert.equal(items.find((item) => item.title === "Mine").source, "bookmark_bar");
  assert.throws(() => imported.importBookmarks("../../outside"));
});

test("imports quoted Chrome CSV locally and matches credentials by HTTPS origin", () => {
  const csv = path.join(root, "passwords.csv");
  fs.writeFileSync(csv, 'name,url,username,password,note\r\nSite,https://example.com/login,user,"sec,ret","line 1\nline 2"\r\n');
  assert.deepEqual(imported.importPasswordsCsv(csv), { ok: true, count: 1 });
  assert.equal(imported.credentialsFor("https://example.com/account")[0].password, "sec,ret");
  assert.deepEqual(imported.credentialsFor("http://example.com/"), []);
  assert.deepEqual(imported.credentialsFor("https://other.example/"), []);
  const vault = fs.readFileSync(path.join(userData, "mbox-browser-vault.bin"));
  assert.equal(vault.includes(Buffer.from("sec,ret")), false);
});
