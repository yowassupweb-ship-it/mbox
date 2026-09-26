// Предзагрузка страниц встроенного браузера (mbox-desktop/browser.js). Моста к MBOX здесь нет и не будет:
// сайт чужой. Единственная задача — не дать сайту без спроса открыть системное окно Windows
// «Войдите, используя ключ безопасности». Chrome сам прячет такие запросы до действия человека,
// а Electron показывал диалог сразу при загрузке страницы — и снова после каждого закрытия.
// Запрос ключа по нажатию (кнопка «Войти с ключом доступа») проходит как обычно.
const { webFrame } = require("electron");

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
