# Контракт UniSender

Навык готовит самостоятельное HTML-письмо для режима кода UniSender. Готовый код можно вставить в редактор либо импортировать HTML-файл. Не рассчитывай на JavaScript, форму, iframe, внешнюю CSS-таблицу или интерактивные элементы.

## Что передать редактору

1. `ready/YYYY-MM-DD-campaign.html` — файл для импорта или вставки в режим кода.
2. Тема и прехедер — отдельными полями в UniSender, даже если скрытый preheader уже есть в HTML.
3. `preview/` — desktop и mobile изображения только для согласования; финальным считается предпросмотр UniSender и тестовое письмо.

В UniSender можно открыть HTML-редактор, вставить код или импортировать HTML/EML/ZIP, переключить desktop/mobile preview и отправить тестовое письмо. Письмо, загруженное в кодовый редактор, сервис умеет распознавать как блоки для последующей правки.

Ссылка отписки: не добавляй `{{UnsubscribeUrl}}` без отдельного решения редактора. UniSender по умолчанию добавляет системный блок отписки; ручная переменная меняет это поведение.

Источники: [HTML-редактор UniSender](https://www.unisender.com/ru/support/letter/newbuilder/kak-sozdat-pismo-v-redaktore-koda/), [ссылка отписки](https://www.unisender.com/ru/support/subscribing-and-unsubscribing/unsubscribing/add-unsubscribe-link/).
