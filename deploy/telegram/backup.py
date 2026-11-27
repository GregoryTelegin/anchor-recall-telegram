#!/usr/bin/env python3
"""Private companion snapshots; --check is read-only, restore requires explicit confirmation."""
import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('anchor_backup_support', Path(__file__).with_name('update.py'))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
BackupError = support.UpdateError
ROOT = Path('/var/backups/anchor-recall-companion')
TOOLS = support.APP / 'backup-tools'
SYSTEMD = Path('/etc/systemd/system')
NAME = 'anchor-recall-backup'
KEEP = 7
SNAPSHOT = re.compile(r'(daily|before-restore)-\d{8}T\d{6}Z-[a-f0-9]{32}')
MANIFEST = 'backup-manifest.json'
MANIFEST_PAGES = '.backup-manifest-pages'
MANIFEST_INLINE_LIMIT = 512 * 1024
MANIFEST_PAGE_LIMIT = 512 * 1024


def tree(root):
    support.directory(root, private=True)
    result = []
    for path in sorted(root.rglob('*')):
        if path.is_dir() and not path.is_symlink():
            support.directory(path, private=True)
        else:
            support.regular(path, private=True)
        result.append(path)
    return result


def rows(root):
    return [{'path': str(path.relative_to(root)).replace(os.sep, '/'),
             'sha256': support.digest(path), 'size': path.stat().st_size}
            for path in tree(root) if path.is_file() and path != root / MANIFEST and root / MANIFEST_PAGES not in path.parents]


def manifest_rows(path, value):
    if value.get('version') == 1:
        if set(value) != {'kind', 'version', 'createdAt', 'files'} or not isinstance(value.get('files'), list) or (path / MANIFEST_PAGES).exists():
            raise BackupError('The backup manifest is not supported.')
        return value['files']
    if (value.get('version') != 2 or set(value) != {'kind', 'version', 'createdAt', 'filesCount', 'firstPage'}
            or type(value['filesCount']) is not int or value['filesCount'] < 0):
        raise BackupError('The backup manifest is not supported.')
    directory = path / MANIFEST_PAGES
    support.directory(directory, private=True, root_owned=True)
    result, seen, reference = [], set(), value['firstPage']
    while reference is not None:
        if (not isinstance(reference, dict) or set(reference) != {'sha256', 'bytes'}
                or not isinstance(reference['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', reference['sha256'])
                or reference['sha256'] in seen or type(reference['bytes']) is not int or not 0 < reference['bytes'] <= MANIFEST_PAGE_LIMIT):
            raise BackupError('Invalid backup manifest page reference.')
        seen.add(reference['sha256'])
        page_path = directory / (reference['sha256'] + '.json')
        support.regular(page_path, private=True, root_owned=True)
        page, raw = support.private_json_bytes(page_path, MANIFEST_PAGE_LIMIT)
        if len(raw) != reference['bytes'] or hashlib.sha256(raw).hexdigest() != reference['sha256']:
            raise BackupError('Backup manifest page checksum differs.')
        if (page.get('version') != 1 or not {'version', 'files'}.issubset(page)
                or not set(page).issubset({'version', 'files', 'next'}) or not isinstance(page['files'], list)):
            raise BackupError('Invalid backup manifest page.')
        result.extend(page['files']); reference = page.get('next')
    if len(result) != value['filesCount'] or {entry.name for entry in tree(directory)} != {digest + '.json' for digest in seen}:
        raise BackupError('Backup manifest page inventory differs.')
    return result


def write_manifest(path, stamp, expected):
    files = rows(path)
    size = 128
    for row in files:
        size += len(json.dumps(row, ensure_ascii=True, sort_keys=True).encode('utf-8')) + 2
        if size > MANIFEST_INLINE_LIMIT:
            break
    header = {'kind': 'anchor-recall-private-backup', 'version': 1, 'createdAt': stamp}
    if size <= MANIFEST_INLINE_LIMIT:
        private_json(path / MANIFEST, {**header, 'files': files})
        return
    directory = path / MANIFEST_PAGES
    expected.add(MANIFEST_PAGES); directory.mkdir(mode=0o700)
    groups, group, size = [], [], 1024
    for row in files:
        length = len(json.dumps(row, ensure_ascii=True, sort_keys=True).encode('utf-8')) + 2
        if length + 1024 > MANIFEST_PAGE_LIMIT:
            raise BackupError('A backup manifest record is oversized.')
        if group and size + length > MANIFEST_PAGE_LIMIT:
            groups.append(group); group, size = [], 1024
        group.append(row); size += length
    if group:
        groups.append(group)
    reference = None
    for group in reversed(groups):
        page = {'version': 1, 'files': group}
        if reference is not None:
            page['next'] = reference
        raw = (json.dumps(page, ensure_ascii=True, sort_keys=True) + '\n').encode('utf-8')
        if len(raw) > MANIFEST_PAGE_LIMIT:
            raise BackupError('A backup manifest page is oversized.')
        reference = {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        name = reference['sha256'] + '.json'; expected.add(MANIFEST_PAGES + '/' + name)
        private_json(directory / name, page)
        if support.digest(directory / name) != reference['sha256']:
            raise BackupError('Backup manifest page verification failed.')
    sync_directory(directory)
    private_json(path / MANIFEST, {**header, 'version': 2, 'filesCount': len(files), 'firstPage': reference})


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=True, sort_keys=True)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())


def sync_directory(path):
    if os.name == 'nt':
        return  # The shipped helper runs on Linux; Windows fixtures cannot fsync directory handles.
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_json(path):
    if path.parent.name.endswith('.pages'):
        return support.read_catalog_page(path)
    if path.parent.name.endswith('.blobs'):
        return support.read_catalog_blob(path)[0]
    if support.regular(path, private=True).st_size > 25 * 1024 * 1024:
        raise BackupError('A journal is too large for offline verification.')
    value, _ = support.private_json_bytes(path, 25 * 1024 * 1024)
    if path.name == 'gateway.json':
        return support.hydrate_gateway_journal(value, path)
    return support.hydrate_catalog_journal(value, path)[0]


def listener(config):
    host = config.get('host', '127.0.0.1')
    address = ipaddress.ip_address('127.0.0.1' if host == 'localhost' else host)
    local = address.is_loopback or address.version == 4 and any(address in ipaddress.IPv4Network(network)
        for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    if config.get('port', 8787) != 8787 or not local:
        raise BackupError('The private listener differs from the supported installation; the service was not stopped.')
    return str(address)


def restart(host):
    support.run(['systemctl', 'start', support.UNIT], timeout=60)
    try:
        support.probe_service(host)
    except Exception:
        raise BackupError('The companion did not become ready after backup/restore. Inspect the service and preserved copies.') from None


def no_renewed_permissions(saved_state, current_state):
    message = 'Restore would renew withdrawn access or its permission history is unavailable. Current state was preserved; use a reviewed recovery.'
    def gateway(root):
        value = read_json(root / 'gateway.json')
        if not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('accounts'), list):
            raise BackupError(message)
        accounts = {}
        for row in value['accounts']:
            if (not isinstance(row, dict) or type(row.get('active')) is not bool or not isinstance(row.get('enrollment'), str)
                    or not re.fullmatch(r'[a-f0-9]{48}', row['enrollment']) or row['enrollment'] in accounts):
                raise BackupError(message)
            accounts[row['enrollment']] = row
        return value, accounts
    old_gateway, old_accounts = gateway(saved_state)
    new_gateway, new_accounts = gateway(current_state)
    if old_gateway.get('botId') != new_gateway.get('botId'):
        raise BackupError(message)
    now = int(time.time() * 1000)
    # An unexpired cancelled link must not become valid again after restoring an older gateway.
    for pair in old_gateway.get('pairs', []):
        if pair.get('state') != 'confirmed' and pair.get('expiresAt', 0) > now and pair not in new_gateway.get('pairs', []):
            raise BackupError(message)
    for enrollment, old_account in old_accounts.items():
        new_account = new_accounts.get(enrollment)
        identity = ('enrollment', 'scope', 'epoch', 'userId', 'chatId', 'timeZone', 'bridgeSecret', 'webhookSecret')
        if new_account and any(old_account.get(key) != new_account.get(key) for key in identity):
            raise BackupError(message)
        if not old_account['active']:
            continue
        if not new_account or new_account.get('active') is not True:
            raise BackupError(message)
        old = read_json(saved_state / 'accounts' / enrollment / 'journal.json')
        new = read_json(current_state / 'accounts' / enrollment / 'journal.json')
        if (not isinstance(old, dict) or not isinstance(new, dict) or old.get('binding') != new.get('binding')
                or not isinstance(old.get('domain'), dict) or not isinstance(new.get('domain'), dict)
                or old['domain'].get('revoked') is not True and new['domain'].get('revoked') is not False):
            raise BackupError(message)
        if not set(old.get('materialConsentIds', [])).issubset(new.get('materialConsentIds', [])):
            raise BackupError(message)
        if (old.get('attachmentConsent') is not False and new.get('attachmentConsent') is not True
                or old.get('offlineConsent') is True and new.get('offlineConsent') is not True
                or (old.get('studyContext') or {}).get('sourceConsent') is True and (new.get('studyContext') or {}).get('sourceConsent') is not True):
            raise BackupError(message)
        def cards(state):
            return {(card['id'], card['materialId'], card.get('mode')) for card in (state['domain'].get('snapshot') or {}).get('cards', [])}
        if not cards(old).issubset(cards(new)):
            raise BackupError(message)
        def plan(state):
            value = state.get('studyPlan') or {}
            return value.get('enabled') is True, {row['id'] for row in [*value.get('entries', []), *value.get('overview', [])]}
        old_enabled, old_entries = plan(old); new_enabled, new_entries = plan(new)
        old_reminders, new_reminders = old['domain'].get('reminders', {}), new['domain'].get('reminders', {})
        if (old_enabled and not new_enabled or not old_entries.issubset(new_entries)
                or old_reminders.get('enabled') is True and new_reminders.get('enabled') is not True
                or new.get('mutedUntil', 0) > now and old.get('mutedUntil', 0) < new['mutedUntil']
                or new_reminders.get('mutedUntil', 0) > now and old_reminders.get('mutedUntil', 0) < new_reminders['mutedUntil']):
            raise BackupError(message)


def verify(path):
    support.directory(path, private=True, root_owned=True)
    manifest = path / MANIFEST
    if support.regular(manifest, private=True, root_owned=True).st_size > 8 * 1024 * 1024:
        raise BackupError('Backup manifest is too large.')
    value, _ = support.private_json_bytes(manifest, 8 * 1024 * 1024)
    if (not isinstance(value, dict) or value.get('kind') != 'anchor-recall-private-backup' or not isinstance(value.get('createdAt'), str)):
        raise BackupError('The backup manifest is not supported.')
    listed = manifest_rows(path, value)
    actual = rows(path)
    if actual != listed:
        raise BackupError('Backup checksums or its file inventory differ; no restore was performed.')
    expected = {'config.json', *support.FILES}
    names = {row['path'] for row in actual}
    if not expected.issubset(names) or any(name not in expected and not name.startswith('state/') for name in names):
        raise BackupError('The backup contains an unexpected layout.')
    if any(entry.is_dir() and entry not in (path / 'state', path / MANIFEST_PAGES) and path / 'state' not in entry.parents for entry in tree(path)):
        raise BackupError('The backup contains an unexpected directory.')
    if any(entry.name.endswith('.lock') for entry in tree(path / 'state')):
        raise BackupError('The backup contains a journal lock; it was preserved for inspection.')
    for entry in [path / 'config.json', *(p for p in tree(path / 'state') if p.is_file() and p.suffix == '.json')]:
        read_json(entry)
    return {**value, 'files': listed}


def ensure_root():
    support.directory(ROOT.parent, root_owned=True)
    if not ROOT.exists() and not ROOT.is_symlink():
        ROOT.mkdir(mode=0o700)
    support.directory(ROOT, private=True, root_owned=True)


def copy_state(destination):
    for source in support.state_paths():
        target = destination / source.relative_to(support.STATE)
        if source.is_dir():
            target.mkdir(mode=0o700)
            target.chmod(0o700)
        else:
            support.copy_private(source, target)


def prune():
    candidates = sorted((p for p in ROOT.iterdir() if p.name.startswith('daily-') and SNAPSHOT.fullmatch(p.name)), reverse=True)
    for path in candidates[KEEP:]:
        verify(path)  # Only exact, private snapshots owned by this helper may be removed.
        if path.parent != ROOT or path.resolve() != path.absolute():
            raise BackupError('Backup retention refused an unexpected path.')
        shutil.rmtree(path)
        sync_directory(ROOT)


def create(prefix='daily', retention=True):
    ensure_root()
    support.directory(support.APP, root_owned=True)
    if support.regular(support.CONFIG, private=True).st_size > 16384:
        raise BackupError('The private configuration is oversized; the service was not stopped.')
    config = read_json(support.CONFIG)
    if not isinstance(config, dict) or config.get('stateDirectory') != str(support.STATE):
        raise BackupError('The configured state directory differs from the supported installation; no backup was started.')
    host = listener(config)
    support.resolve_node()
    paths = support.state_paths()
    for path in paths:
        if path.is_file() and path.suffix == '.json':
            read_json(path)
    needed = sum(p.stat().st_size for p in paths if p.is_file()) + support.CONFIG.stat().st_size
    needed += sum(support.regular(support.APP / name, root_owned=True).st_size for name in support.FILES)
    if shutil.disk_usage(ROOT).free < needed + max(16 * 1024 * 1024, needed // 10):
        raise BackupError('Not enough free disk space for a complete backup; the service was not stopped.')
    active = support.run(['systemctl', 'show', support.UNIT, '--property=ActiveState', '--value'])
    if active not in ('active', 'inactive'):
        raise BackupError('The service is not in a stable active/inactive state; inspect it before backing up.')
    started, did_stop, complete, baseline, code = time.monotonic(), False, False, None, None
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    name = prefix + '-' + stamp + '-' + uuid.uuid4().hex
    staging = Path(tempfile.mkdtemp(prefix='.pending-', dir=ROOT)); staging.chmod(0o700)
    expected = {'config.json', MANIFEST, *support.FILES, 'state'}
    expected.update('state/' + str(p.relative_to(support.STATE)).replace(os.sep, '/') for p in paths if p != support.STATE)
    try:
        if active == 'active':
            support.stop_service(); did_stop = True
        if any(path.name.endswith('.lock') for path in support.state_paths()):
            raise BackupError('A journal lock remains; no lock was removed or stolen.')
        baseline = support.protected_fingerprint()
        code = {name: support.digest(support.APP / name) for name in support.FILES}
        support.copy_private(support.CONFIG, staging / 'config.json')
        for asset in support.FILES:
            support.copy_private(support.APP / asset, staging / asset)
        copy_state(staging / 'state')
        if (support.protected_fingerprint() != baseline or
                code != {name: support.digest(support.APP / name) for name in support.FILES}):
            raise BackupError('State or runtime changed while backing up; no complete snapshot was published.')
        write_manifest(staging, stamp, expected)
        verify(staging)
        for folder in reversed([p for p in tree(staging) if p.is_dir()]):
            sync_directory(folder)
        sync_directory(staging)
        destination = ROOT / name
        staging.rename(destination); complete = True
        sync_directory(ROOT)
        print('Проверенная закрытая копия: ' + str(destination))
    finally:
        if did_stop:
            unchanged = False
            try:
                unchanged = (baseline is not None and support.protected_fingerprint() == baseline and
                             code == {name: support.digest(support.APP / name) for name in support.FILES})
            except Exception:
                pass
            if unchanged:
                restart(host)
                print('Пауза службы для копирования: ' + str(round(time.monotonic() - started, 1)) + ' с.')
            else:
                print('Состояние источника не подтверждено. Служба оставлена остановленной для проверки.')
        if not complete:
            discarded = False
            try:
                if staging.parent == ROOT and staging.resolve() == staging.absolute() and all(
                        str(p.relative_to(staging)).replace(os.sep, '/') in expected for p in tree(staging)):
                    shutil.rmtree(staging); discarded = True
            except Exception:
                pass
            if not discarded:
                print('Незавершённая закрытая копия сохранена для проверки: ' + str(staging))
    if retention:
        prune()
    return destination


def restore(path, apply=False):
    verify(path)
    # A state-only restore never silently changes a bot identity or downgrades installed code.
    if (support.digest(path / 'config.json') != support.digest(support.CONFIG) or
            any(support.digest(path / asset) != support.digest(support.APP / asset) for asset in support.FILES)):
        raise BackupError('Config/runtime differs from this snapshot. Use a reviewed recovery; current files were preserved.')
    host = listener(read_json(support.CONFIG))
    no_renewed_permissions(path / 'state', support.STATE)
    if not apply:
        print('Копия проверена. Для замены только журналов добавьте --apply; конфигурация и программа останутся прежними.')
        return
    if input('Восстановление заменит текущее серверное состояние. Его копия будет сохранена. Введите RESTORE: ').strip() != 'RESTORE':
        print('Отменено. Серверное состояние не менялось.'); return
    support.resolve_node()
    active = support.run(['systemctl', 'show', support.UNIT, '--property=ActiveState', '--value'])
    if active not in ('active', 'inactive'):
        raise BackupError('The service state is not stable; no restore was performed.')
    support.directory(support.STATE.parent, root_owned=True)
    saved, baseline, restart_safe = None, None, False
    if active == 'active':
        support.stop_service()
    try:
        if any(p.name.endswith('.lock') for p in support.state_paths()):
            raise BackupError('A journal lock remains; restore did not steal it.')
        if (support.digest(path / 'config.json') != support.digest(support.CONFIG) or
                any(support.digest(path / asset) != support.digest(support.APP / asset) for asset in support.FILES)):
            raise BackupError('Config/runtime changed before restore; current state was preserved.')
        baseline = support.protected_fingerprint()
        no_renewed_permissions(path / 'state', support.STATE)
        saved = create('before-restore', retention=False)
        if support.protected_fingerprint() != baseline:
            raise BackupError('Current state changed during pre-restore backup; external changes were preserved.')
        candidate = Path(tempfile.mkdtemp(prefix='.anchor-recall-restore-', dir=support.STATE.parent))
        candidate.rmdir()
        shutil.copytree(path / 'state', candidate, copy_function=lambda source, target: support.copy_private(Path(source), Path(target)))
        import pwd
        account = pwd.getpwnam(support.USER)
        for entry in [candidate, *tree(candidate)]:
            entry.chmod(0o700 if entry.is_dir() else 0o600)
            os.chown(entry, account.pw_uid, account.pw_gid)
        if rows(candidate) != [dict(row, path=row['path'][6:]) for row in verify(path)['files'] if row['path'].startswith('state/')]:
            raise BackupError('The prepared recovery copy differs; current state was preserved.')
        if (support.protected_fingerprint() != baseline or
                any(support.digest(path / asset) != support.digest(support.APP / asset) for asset in support.FILES)):
            raise BackupError('Current state changed before restore; external changes were preserved.')
        no_renewed_permissions(candidate, support.STATE)
        prior = support.STATE.with_name('.anchor-recall-before-restore-' + uuid.uuid4().hex)
        for folder in reversed([p for p in tree(candidate) if p.is_dir()]):
            sync_directory(folder)
        sync_directory(candidate)
        support.STATE.rename(prior)
        try:
            candidate.rename(support.STATE)
        except Exception:
            if not support.STATE.exists() and not support.STATE.is_symlink():
                prior.rename(support.STATE)
            raise
        restart_safe = True
        sync_directory(support.STATE.parent)
        print('Журналы восстановлены. Предыдущее состояние: ' + str(prior))
        print('Проверенная копия до восстановления: ' + str(saved))
    finally:
        if active == 'active':
            try:
                restart_safe = restart_safe or baseline is not None and support.protected_fingerprint() == baseline
            except Exception:
                restart_safe = False
            if restart_safe:
                restart(host)
            else:
                print('Восстановление не подтверждено. Служба оставлена остановленной; сохраните обе копии.')


def timer_files():
    service = ('[Unit]\nDescription=Private Anchor Recall state backup\n[Service]\nType=oneshot\nUser=root\n'
               'UMask=0077\nNice=10\nIOSchedulingClass=idle\nTimeoutStartSec=0\n'
               'ExecStart=/usr/bin/python3 ' + str(TOOLS / 'backup.py') + ' --create\n')
    timer = ('[Unit]\nDescription=Daily Anchor Recall state backup\n[Timer]\nOnCalendar=*-*-* 03:00:00\n'
             'RandomizedDelaySec=300\nPersistent=true\nUnit=' + NAME + '.service\n[Install]\nWantedBy=timers.target\n')
    return {NAME + '.service': service.encode(), NAME + '.timer': timer.encode()}


def install_timer(package):
    support.directory(support.APP, root_owned=True)
    support.directory(SYSTEMD, root_owned=True)
    hashes = {}
    for line in (package / 'SHA256SUMS').read_text('utf-8').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
        if not match or match[2] in hashes:
            raise BackupError('Invalid package checksums; timer was not enabled.')
        hashes[match[2]] = match[1]
    for name in ('backup.py', 'update.py'):
        if support.digest(package / name) != hashes.get(name):
            raise BackupError('Backup helper checksums failed; timer was not enabled.')
    units = timer_files()
    for name, content in units.items():
        path = SYSTEMD / name
        if path.exists() or path.is_symlink():
            support.regular(path, root_owned=True)
            if path.read_bytes() != content:
                raise BackupError('A different timer/service already exists; it was preserved.')
    if not TOOLS.exists() and not TOOLS.is_symlink():
        TOOLS.mkdir(mode=0o700)
    support.directory(TOOLS, private=True, root_owned=True)
    if set(p.name for p in TOOLS.iterdir()) - {'backup.py', 'update.py'}:
        raise BackupError('The backup tools directory contains unrelated files; it was preserved.')
    create()  # Prove a complete, verified backup before enabling unattended operation.
    for name in ('backup.py', 'update.py'):
        target = TOOLS / name
        if target.exists() or target.is_symlink():
            support.regular(target, private=True, root_owned=True)
        temporary = TOOLS / ('.install-' + uuid.uuid4().hex)
        support.copy_private(package / name, temporary); temporary.replace(target)
    for name, content in units.items():
        path = SYSTEMD / name
        if not path.exists():
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(content); stream.flush(); os.fsync(stream.fileno())
    support.run(['systemd-analyze', 'verify', *(SYSTEMD / name for name in units)], timeout=30)
    support.run(['systemctl', 'daemon-reload'])
    support.run(['systemctl', 'enable', NAME + '.timer'])


@contextlib.contextmanager
def operator_lock():
    if platform.system() != 'Linux' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise BackupError('Run sudo python3 backup.py on the Debian server.')
    import fcntl
    descriptor = os.open('/run/lock/anchor-recall-companion-update.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise BackupError('The operator lock is unsafe; it was preserved.')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError('Another update/backup/restore is running; nothing was stopped.') from None
        yield
    finally:
        os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--check', type=Path, metavar='BACKUP', help='Verify a private snapshot offline; never stop or write state.')
    action.add_argument('--create', action='store_true', help='Create a consistent private snapshot and retain the last seven daily copies.')
    action.add_argument('--install-timer', action='store_true', help='Verify a first backup, then install the explicit daily systemd timer.')
    action.add_argument('--restore', type=Path, metavar='BACKUP', help='Check recovery compatibility; add --apply and type RESTORE to replace state.')
    parser.add_argument('--apply', action='store_true', help='Permit state restoration after a separate RESTORE confirmation.')
    args = parser.parse_args(argv)
    if args.apply and not args.restore:
        parser.error('--apply requires --restore')
    try:
        with operator_lock():
            if args.check:
                verify(args.check); print('Контрольные суммы, состав файлов и JSON копии проверены офлайн. Данные и служба не менялись.')
            elif args.create:
                create()
            elif args.install_timer:
                install_timer(Path(__file__).resolve().parent)
            else:
                restore(args.restore, args.apply)
        if args.install_timer:
            # A persistent timer may run immediately; release the shared operator lock first.
            support.run(['systemctl', 'start', NAME + '.timer'])
            print('Ежедневная копия включена: 03:00 по времени ноутбука, хранятся последние 7 успешных копий.')
        return 0
    except Exception as error:
        if isinstance(error, BackupError):
            print(str(error))
        print('Операция резервирования остановлена. Проверьте состояние службы и закрытые копии; секреты и содержимое журналов не выводятся.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
