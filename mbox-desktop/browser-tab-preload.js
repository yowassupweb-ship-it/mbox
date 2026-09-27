// Предзагрузка страниц встроенного браузера (mbox-desktop/browser.js). Моста к MBOX здесь нет и не будет:
// сайт чужой. Единственная задача — не дать сайту без спроса открыть системное окно Windows
// «Войдите, используя ключ безопасности». Chrome сам прячет такие запросы до действия человека,
// а Electron показывал диалог сразу при загрузке страницы — и снова после каждого закрытия.
// Запрос ключа по нажатию (кнопка «Войти с ключом доступа») проходит как обычно.
const { webFrame } = require("electron");

const chromeMajor = String(process.versions.chrome || "130").split(".")[0];
const chromePlatform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";

webFrame.executeJavaScript(`(() => {
  const brands = [
    { brand: "Chromium", version: ${JSON.stringify(chromeMajor)} },
    { brand: "Google Chrome", version: ${JSON.stringify(chromeMajor)} },
    { brand: "Not?A_Brand", version: "99" },
  ];
  const data = {
    brands,
    mobile: false,
    platform: ${JSON.stringify(chromePlatform)},
    getHighEntropyValues(keys) {
      const values = {
        architecture: "x86",
        bitness: "64",
        brands,
        fullVersionList: brands.map((item) => ({ brand: item.brand, version: item.brand === "Not?A_Brand" ? "99.0.0.0" : item.version + ".0.0.0" })),
        mobile: false,
        model: "",
        platform: ${JSON.stringify(chromePlatform)},
        platformVersion: "15.0.0",
        uaFullVersion: ${JSON.stringify(chromeMajor + ".0.0.0")},
        wow64: false,
      };
      const picked = {};
      for (const key of keys || []) picked[key] = values[key];
      return Promise.resolve(picked);
    },
    toJSON() { return { brands, mobile: false, platform: ${JSON.stringify(chromePlatform)} }; },
  };
  try {
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: () => data, configurable: true });
  } catch {}
})()`).catch(() => {});

webFrame.executeJavaScript(`(() => {
  const credentials = navigator.credentials;
  if (!credentials || typeof credentials.get !== "function") return;
  const original = credentials.get.bind(credentials);
  credentials.get = function get(options) {
    const wantsKey = options && options.publicKey;
    const byUser = navigator.userActivation && navigator.userActivation.isActive;
    if (wantsKey && (options.mediation === "conditional" || !byUser)) {
      return Promise.reject(new DOMException("Запрос ключа безопасности без действия пользователя", "NotAllowedError"));
    }
    return original(options);
  };
})()`).catch(() => {});
