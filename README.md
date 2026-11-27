# Anchor Recall: Telegram для своего сервера

Telegram-бот и Mini App для [Anchor Recall](https://github.com/GregoryTelegin/anchor-recall-beta). Разверните службу на своём сервере, подключите её в Obsidian и выберите материалы для передачи. Один сервер может обслуживать несколько пользователей. Это не публичный бот и не готовый хостинг.

## Установка на Debian

1. [Скачайте серверный ZIP](artifacts/AnchorRecall-Telegram-0.9.31.zip) и распакуйте его целиком. Это отдельный архив, не ZIP плагина Obsidian.
2. Создайте бота в [BotFather](https://t.me/BotFather). Токен вводите только в установщике, не публикуйте его.
3. Следуйте [инструкции по установке](docs/telegram-companion-quickstart-ru.md). Нужны Debian 12 или новее, systemd и доступный по HTTPS адрес. Готовой сборке на сервере не нужны npm и инструменты сборки.
4. В Obsidian откройте **Anchor Recall → Интеграции → Telegram**, введите адрес своей службы и выберите материалы для передачи.

Рекомендуемая пара для первого запуска: сервер 0.9.31 и [плагин 0.9.31](https://github.com/GregoryTelegin/anchor-recall-beta/releases/tag/0.9.31). По отдельному согласию можно повторять выбранные FSRS-карточки при закрытом Obsidian: копия на сервере действует до 30 дней. Результаты переносятся после синхронизации с Obsidian.

[Настройка Mini App](docs/telegram-miniapp.md) · [Резервные копии](docs/telegram-backups.md) · [Диагностика](docs/telegram-health.md) · [Подробная установка](docs/telegram-companion-debian.md)

## Сборка из исходников

Нужен Node.js 24 или новее. На машине для сборки:

```sh
npm ci
npm run build
npm run smoke
```

Готовые файлы будут в `dist/telegram-companion/`. Команда проверки выводит справку и не запускает сервер.

Код Anchor Recall распространяется по [PolyForm Noncommercial 1.0.0](LICENSE). [Лицензии сторонних компонентов](THIRD_PARTY_NOTICES.md) сохранены.
