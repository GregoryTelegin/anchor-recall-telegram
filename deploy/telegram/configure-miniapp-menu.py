#!/usr/bin/env python3
"""Explicit Telegram menu configuration; never write local settings or learner data."""
import argparse
import http.client
import json
import os
from pathlib import Path
import platform
import re
import ssl
import types


class MenuError(Exception):
    """Only static, secret-free operator messages cross this boundary."""


def load_helpers():
    path = Path(__file__).with_name('enable-miniapp.py')
    helper = types.ModuleType('_anchor_recall_miniapp_config_support')
    helper.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), helper.__dict__)
    return helper, helper.load_support()


def read_config(helper, support):
    for path in (support.CONFIG.parent, *support.CONFIG.parent.parents):
        support.directory(path, root_owned=True)
    info = support.regular(support.CONFIG, private=True)
    if info.st_size > 16384 or (info.st_uid, info.st_gid) != helper.service_ids(support.USER):
        raise MenuError('The private configuration differs from the supported native installation.')
    baseline = helper.fingerprint(support, support.CONFIG)
    with support.CONFIG.open('rb') as stream:
        raw = stream.read(16385)
    if len(raw) > 16384:
        raise MenuError('The private configuration exceeds the supported size.')
    config = json.loads(raw, object_pairs_hook=helper.unique_object)
    if not isinstance(config, dict) or config.get('enabled') is not True:
        raise MenuError('Enable the companion and configure its Mini App URL before configuring the menu.')
    url, token = config.get('miniAppUrl'), config.get('botToken')
    helper.validate_url(url)
    if not isinstance(token, str) or len(token) > 256 or not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]{20,}', token):
        raise MenuError('The stored bot token is invalid. Check the private server configuration.')
    if helper.fingerprint(support, support.CONFIG) != baseline:
        raise MenuError('Configuration changed while being read. Retry with the current configuration.')
    return url, token, baseline


def telegram(token, method, payload):
    connection = http.client.HTTPSConnection('api.telegram.org', timeout=15, context=ssl.create_default_context())
    try:
        connection.request('POST', '/bot' + token + '/' + method,
                           body=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        if response.status == 401:
            raise MenuError('Telegram rejected the stored bot token. Check it in the private server configuration.')
        if response.status == 429:
            raise MenuError('Telegram rate limit reached. Wait and rerun the same command.')
        if response.status != 200:
            raise MenuError('Telegram did not confirm the request. Check connectivity and rerun the same command.')
        raw = response.read(16385)
        if len(raw) > 16384:
            raise MenuError('Telegram returned an unexpected response. The menu was not confirmed.')
        result = json.loads(raw)
        if not isinstance(result, dict) or result.get('ok') is not True:
            raise MenuError('Telegram did not confirm the request. Check the bot configuration and retry.')
        return result.get('result')
    except MenuError:
        raise
    except (TimeoutError, OSError, http.client.HTTPException, ValueError):
        raise MenuError('Cannot confirm the Telegram menu. Check the server VPN, HTTPS connectivity and system time, then rerun the same command.') from None
    finally:
        connection.close()


def configure():
    if platform.system() != 'Linux' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise MenuError('Run sudo python3 configure-miniapp-menu.py --apply on the Debian server.')
    helper, support = load_helpers()
    url, token, baseline = read_config(helper, support)
    menu = {'type': 'web_app', 'text': 'Открыть занятие', 'web_app': {'url': url}}
    if telegram(token, 'setChatMenuButton', {'menu_button': menu}) is not True:
        raise MenuError('Telegram did not confirm the menu change. Rerun the same command.')
    if helper.fingerprint(support, support.CONFIG) != baseline:
        raise MenuError('Configuration changed during setup. Rerun with the current configuration to confirm the menu.')
    if telegram(token, 'getChatMenuButton', {}) != menu:
        raise MenuError('The Telegram menu differs from the requested button. Rerun the same command to confirm it.')
    print('Меню Telegram подтверждено: «Открыть занятие». Откройте чат бота заново; вводить /app больше не нужно.')
    print('Локальные настройки и история не изменялись. Перезапуск службы не требуется.')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Configure the persistent Telegram launch button from the existing private Mini App configuration.')
    parser.add_argument('--apply', action='store_true', help='Set and confirm the bot default menu button in Telegram.')
    args = parser.parse_args(argv)
    if not args.apply:
        parser.print_help(); return 0
    try:
        configure(); return 0
    except MenuError as error:
        print('Mini App menu configuration stopped: ' + str(error)); return 1
    except Exception:
        print('Mini App menu configuration stopped. Check the existing private configuration and its Mini App URL; sensitive details were withheld.'); return 1


if __name__ == '__main__':
    raise SystemExit(main())
