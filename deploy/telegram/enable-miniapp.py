#!/usr/bin/env python3
"""Explicit config-only Mini App activation; never restart or touch learner journals."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import stat
import tempfile
import types
from urllib.parse import urlsplit


class ConfigError(Exception):
    """Only static, secret-free operator errors leave this helper."""


def validate_url(value):
    try:
        url = urlsplit(value)
        host, port = url.hostname, url.port
        if not host or url.scheme != 'https' or url.username is not None or url.password is not None or url.path != '/miniapp/' or url.query or url.fragment:
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
            host = '[' + str(address) + ']' if address.version == 6 else str(address)
        except ValueError:
            if (not re.fullmatch(r'[a-z0-9.-]+', host) or re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]+)', host.split('.')[-1])
                    or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.'))):
                raise ValueError()
        canonical = 'https://' + host + (':' + str(port) if port not in (None, 443) else '') + '/miniapp/'
        if not isinstance(value, str) or len(value) > 2048 or value != canonical or port is not None and not 0 < port <= 65535:
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError):
        raise ConfigError('Use a canonical HTTPS address ending exactly in /miniapp/, without credentials or query parameters.') from None


def load_support():
    path = Path(__file__).with_name('update.py')
    support = types.ModuleType('_anchor_recall_update_support')
    support.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec'), support.__dict__)
    return support


def service_ids(user):
    import pwd
    account = pwd.getpwnam(user)
    return account.pw_uid, account.pw_gid


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fingerprint(support, path):
    info = support.regular(path, private=True)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, support.digest(path))


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError('Ambiguous configuration keys; the original file was preserved.')
        result[key] = value
    return result


def apply_url(value, support):
    value = validate_url(value)
    for path in (support.CONFIG.parent, *support.CONFIG.parent.parents, support.APP, *support.APP.parents, support.UNIT_FILE.parent, *support.UNIT_FILE.parent.parents):
        support.directory(path, root_owned=True)
    info = support.regular(support.CONFIG, private=True)
    uid, gid = service_ids(support.USER)
    if info.st_size > 16384 or (info.st_uid, info.st_gid) != (uid, gid):
        raise ConfigError('The private configuration differs from the supported native installation.')
    baseline = fingerprint(support, support.CONFIG)
    config = json.loads(support.CONFIG.read_text('utf-8'), object_pairs_hook=unique_object)
    if not isinstance(config, dict):
        raise ConfigError('The existing configuration must be an object.')
    unchanged = config.get('miniAppUrl') == value
    config['miniAppUrl'] = value
    data = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if len(data) > 16384:
        raise ConfigError('The resulting configuration exceeds the supported size.')
    node = support.resolve_node()
    runtime = support.APP / 'anchor-recall-companion.cjs'
    support.regular(runtime, root_owned=True)
    runtime_hash = support.digest(runtime)
    descriptor, name = tempfile.mkstemp(prefix='.anchor-miniapp-', dir=support.CONFIG.parent)
    candidate, backup = Path(name), None
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        support.run(['runuser', '--user', support.USER, '--', node, runtime, '--check', '--config', candidate])
        candidate_info = support.regular(candidate, private=True)
        if (candidate.read_bytes() != data or stat.S_IMODE(candidate_info.st_mode) != stat.S_IMODE(info.st_mode)
                or (candidate_info.st_uid, candidate_info.st_gid) != (info.st_uid, info.st_gid)
                or fingerprint(support, support.CONFIG) != baseline or support.digest(runtime) != runtime_hash):
            raise ConfigError('Configuration or code changed during validation; no replacement was made.')
        candidate_fingerprint = fingerprint(support, candidate)
        if unchanged:
            print('Адрес Mini App уже настроен и прошёл офлайн-проверку. Файлы не изменены.')
            return None
        support.directory(support.BACKUPS, root_owned=True)
        backup = Path(tempfile.mkdtemp(prefix='anchor-recall-before-miniapp-', dir=support.BACKUPS))
        backup.chmod(0o700)
        support.copy_private(support.CONFIG, backup / 'config.json')
        support.regular(backup / 'config.json', private=True, root_owned=True)
        if (support.digest(backup / 'config.json') != baseline[-1] or fingerprint(support, support.CONFIG) != baseline
                or fingerprint(support, candidate) != candidate_fingerprint or support.digest(runtime) != runtime_hash):
            raise ConfigError('Configuration changed during backup; the external change was preserved.')
        print('Закрытая резервная копия: ' + str(backup))
        os.replace(candidate, support.CONFIG)
        sync_directory(support.CONFIG.parent)
        print('Настроен только адрес Mini App. Служба не перезапускалась.')
        print('Для применения: sudo systemctl restart ' + support.UNIT)
        return backup
    finally:
        candidate.unlink(missing_ok=True)


def enable(value):
    validate_url(value)
    if platform.system() != 'Linux' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise ConfigError('Run sudo python3 enable-miniapp.py --url https://PUBLIC/miniapp/ on the Debian server.')
    import fcntl
    support = load_support()
    descriptor = os.open('/run/lock/anchor-recall-companion-update.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ConfigError('The operator update lock is unsafe; it was preserved.')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ConfigError('Another companion update is running; no configuration was changed.') from None
        try:
            return apply_url(value, support)
        except support.UpdateError as error:
            raise ConfigError(str(error)) from None
    finally:
        os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description='Configure only the Mini App URL; preserve all other settings and learner data.')
    parser.add_argument('--url', help='Canonical HTTPS address ending in /miniapp/.')
    args = parser.parse_args(argv)
    if not args.url:
        parser.print_help(); return 0
    try:
        enable(args.url); return 0
    except ConfigError as error:
        print('Mini App configuration stopped: ' + str(error)); return 1
    except Exception:
        print('Mini App configuration stopped; inspect the private configuration and backup before retrying. No service restart was attempted.'); return 1


if __name__ == '__main__':
    raise SystemExit(main())
