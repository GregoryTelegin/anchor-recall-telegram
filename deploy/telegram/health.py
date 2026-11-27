#!/usr/bin/env python3
"""Read-only, content-free checks for an existing native companion installation."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import sys
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('anchor_health_support', Path(__file__).with_name('update.py'))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)

JOURNAL_LIMIT = 20_000_000
BACKUPS = Path('/var/backups/anchor-recall-companion')
BACKUP_NAME = re.compile(r'daily-\d{8}T\d{6}Z-[a-f0-9]{32}')
LEVELS = {'ok': 0, 'warning': 1, 'critical': 2}
LEDGERS = {'nonces': 10000}
REQUIRED_JOURNAL_LEDGERS = ('handles', 'updates', 'callbackIds', 'receipts', 'outbox')
JOURNAL_COUNTS = (*REQUIRED_JOURNAL_LEDGERS, 'miniAppReceipts', 'miniAppAttempts', 'editableGrades', 'gradeCorrections',
                  'claimedAttempts', 'studyPlanSent', 'supersededOfflineReviews', 'planCommands', 'planCommandReceipts',
                  'cardReports', 'cardReportReceipts', 'writtenRecalls', 'writtenRecallReceipts',
                  'answerHistory', 'answerHistoryReferences', 'answerHistoryReceipts')


class HealthError(Exception):
    pass


def private_file(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077:
        raise HealthError()


def object_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise HealthError()
        value[key] = item
    return value


def invalid_constant(_):
    raise HealthError()


def read_private_json(path, maximum):
    support.regular(path, private=True)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno()); private_file(before)
        if before.st_size > maximum:
            raise HealthError()
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno()); private_file(after)
        if (len(raw) > maximum or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise HealthError()
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=object_pairs, parse_constant=invalid_constant)
    if not isinstance(value, dict):
        raise HealthError()
    return value, len(raw)


def percent(used, limit):
    return round(100 * used / limit, 2)


def pressure(value):
    return 'critical' if value >= 90 else 'warning' if value >= 75 else 'ok'


def add_check(report, name, status):
    report['checks'].append({'name': name, 'status': status})


def ledger_counts(value, limits, required=()):
    result = []
    for key, limit in limits.items():
        rows = value.get(key, None if key in required else [])
        if not isinstance(rows, list):
            raise HealthError()
        result.append((key, len(rows), limit))
    return result


def measure_journal(value, size, capacity, gateway=False, config=None):
    if value.get('version') != 1:
        raise HealthError()
    if gateway:
        limits = {'pairs': config.get('maxPendingPairings', 1000), 'inbox': 10000, 'disconnects': 1000}
        account_limit = config.get('maxAccounts')
        if 'maxAccounts' in config:
            if type(account_limit) is not int or not 1 <= account_limit <= 9007199254740991:
                raise HealthError()
        if any(type(limit) is not int or not 1 <= limit <= 10000 for limit in limits.values()):
            raise HealthError()
        accounts, outputs = value.get('accounts'), value.get('notices')
        if (not isinstance(accounts, list) or any(not isinstance(row, dict) or type(row.get('active', True)) is not bool for row in accounts)
                or not isinstance(outputs, list) or any(not isinstance(row, dict) or row.get('status') not in ('queued', 'unknown') for row in outputs)):
            raise HealthError()
        active = sum(row.get('active', True) for row in accounts)
        capacity.update(activeAccounts=active, archivedAccounts=len(accounts) - active)
        counts = ledger_counts(value, limits, required=limits)
        if account_limit is not None:
            counts.append(('activeAccounts', active, account_limit))
        queued = sum(row['status'] == 'queued' for row in outputs)
        if queued > 1000:
            raise HealthError()
        counts.append(('queuedNotices', queued, 1000))
    else:
        domain = value.get('domain')
        if not isinstance(domain, dict) or domain.get('version') != 1:
            raise HealthError()
        counts = ledger_counts(value, LEDGERS, required=('nonces',))
        for field in JOURNAL_COUNTS:
            rows = value.get(field, None if field in REQUIRED_JOURNAL_LEDGERS else [])
            if not isinstance(rows, list):
                raise HealthError()
            capacity[field] += len(rows)
        for field, count in (('pending', 'pendingAnswers'), ('outcomes', 'storedReviewOutcomes'), ('callbacks', 'storedCallbackReceipts')):
            rows = domain.get(field)
            if not isinstance(rows, list):
                raise HealthError()
            capacity[count] += len(rows)
        answer_bytes = sum(len(json.dumps(value.get(key, []), ensure_ascii=False, separators=(',', ':')).encode('utf-8', 'backslashreplace'))
                           for key in ('answerHistory', 'answerHistoryReferences'))
        capacity['largestAnswerHistoryBytes'] = max(answer_bytes, capacity['largestAnswerHistoryBytes'])
        outputs = value.get('outbox', [])
    if any(not isinstance(row, dict) or row.get('status') not in ('queued', 'unknown', 'sent') for row in outputs):
        raise HealthError()
    capacity['journalFiles'] += 1
    capacity['largestJournalBytes'] = max(size, capacity['largestJournalBytes'])
    for name, used, limit in counts:
        usage = percent(used, limit)
        if usage > capacity['highestLedgerPercent']:
            capacity.update(highestLedger=name, highestLedgerEntries=used, highestLedgerLimit=limit,
                            highestLedgerPercent=usage)
    capacity['queuedDeliveries'] += sum(row['status'] == 'queued' for row in outputs)
    capacity['unknownDeliveries'] += sum(row['status'] == 'unknown' for row in outputs)


def state_check(report):
    support.directory(support.CONFIG.parent, root_owned=True)
    config, _ = read_private_json(support.CONFIG, 16384)
    if config.get('version') != 1 or config.get('stateDirectory') != str(support.STATE):
        raise HealthError()
    support.directory(support.STATE, private=True)
    gateway_path = support.STATE / 'gateway.json'
    gateway, size = read_private_json(gateway_path, JOURNAL_LIMIT)
    gateway = support.hydrate_gateway_journal(gateway, gateway_path)
    capacity = {'journalFiles': 0, 'largestJournalBytes': 0, 'journalByteLimit': JOURNAL_LIMIT,
                'highestLedger': None, 'highestLedgerEntries': 0, 'highestLedgerLimit': 0,
                'highestLedgerPercent': 0, 'largestAnswerHistoryBytes': 0,
                'pendingAnswers': 0, 'storedReviewOutcomes': 0, 'storedCallbackReceipts': 0,
                'queuedDeliveries': 0, 'unknownDeliveries': 0}
    capacity.update(dict.fromkeys(JOURNAL_COUNTS, 0))
    measure_journal(gateway, size, capacity, gateway=True, config=config)
    known_accounts = set()
    for account in gateway['accounts']:
        enrollment = account.get('enrollment') if isinstance(account, dict) else None
        if not isinstance(enrollment, str) or not re.fullmatch(r'[a-f0-9]{48}', enrollment) or enrollment in known_accounts:
            raise HealthError()
        known_accounts.add(enrollment)
    scanned_accounts = set()
    accounts = support.STATE / 'accounts'
    if accounts.exists() or accounts.is_symlink():
        support.directory(accounts, private=True)
        for account in accounts.iterdir():
            if not re.fullmatch(r'[a-f0-9]{48}', account.name):
                raise HealthError()
            support.directory(account, private=True)
            journal = account / 'journal.json'
            if not journal.exists() and not journal.is_symlink():
                continue  # Account journals are created lazily; report missing coverage, never create one.
            value, size = read_private_json(journal, JOURNAL_LIMIT)
            value, catalog_bytes = support.hydrate_catalog_journal(value, journal)
            capacity['largestCatalogBytes'] = max(capacity.get('largestCatalogBytes', 0), catalog_bytes)
            measure_journal(value, size, capacity)
            scanned_accounts.add(account.name)
    capacity['missingAccountJournals'] = len(known_accounts - scanned_accounts)
    capacity['unregisteredAccountJournals'] = len(scanned_accounts - known_accounts)
    capacity['countsComplete'] = not (capacity['missingAccountJournals'] or capacity['unregisteredAccountJournals'])
    report['capacity'] = capacity
    add_check(report, 'journal.coverage', 'ok' if capacity['countsComplete'] else 'warning')
    add_check(report, 'journal.bytes', pressure(percent(capacity['largestJournalBytes'], JOURNAL_LIMIT)))
    add_check(report, 'journal.ledgers', pressure(capacity['highestLedgerPercent']))
    add_check(report, 'delivery.unknown', 'warning' if capacity['unknownDeliveries'] else 'ok')


def disk_check(report):
    support.directory(support.STATE, private=True)
    disk = shutil.disk_usage(support.STATE)
    if disk.total <= 0 or disk.free < 0 or disk.free > disk.total:
        raise HealthError()
    report['disk'] = {'freeBytes': disk.free, 'totalBytes': disk.total, 'usedPercent': percent(disk.total - disk.free, disk.total)}
    add_check(report, 'disk.space', 'critical' if disk.free < 100 * 1024 * 1024 else pressure(report['disk']['usedPercent']))


def service_check(report, name, unit, required=False):
    raw = support.run(['systemctl', 'show', unit, '--property=LoadState,ActiveState,UnitFileState'], timeout=10)
    fields = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    known = fields.get('LoadState') == 'loaded'
    active = known and fields.get('ActiveState') == 'active'
    enabled = known and fields.get('UnitFileState') == 'enabled'
    report['services'][name] = {'loaded': known, 'active': active, 'enabled': enabled}
    add_check(report, 'service.' + name, 'critical' if required and not active else 'ok' if active and enabled else 'warning')


def backups_check(report, now):
    report['backups'] = {'completedSnapshots': 0, 'newestAgeHours': None, 'integrityChecked': False}
    if not BACKUPS.exists() and not BACKUPS.is_symlink():
        add_check(report, 'backups.completed', 'warning'); return
    support.directory(BACKUPS, private=True, root_owned=True)
    newest = None
    for path in BACKUPS.iterdir():
        if not BACKUP_NAME.fullmatch(path.name):
            continue
        support.directory(path, private=True, root_owned=True)
        manifest, _ = read_private_json(path / 'backup-manifest.json', 8 * 1024 * 1024)
        stamp = datetime.datetime.strptime(path.name[6:22], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc)
        version = manifest.get('version')
        if (manifest.get('kind') != 'anchor-recall-private-backup' or type(version) is not int
                or manifest.get('createdAt') != stamp.strftime('%Y%m%dT%H%M%SZ')):
            raise HealthError()
        if version == 1:
            if set(manifest) != {'kind', 'version', 'createdAt', 'files'} or not isinstance(manifest['files'], list) or not manifest['files']:
                raise HealthError()
        elif version == 2:
            if (set(manifest) != {'kind', 'version', 'createdAt', 'filesCount', 'firstPage'}
                    or type(manifest['filesCount']) is not int or manifest['filesCount'] <= 0):
                raise HealthError()
            first = manifest['firstPage']
            if (not isinstance(first, dict) or set(first) != {'sha256', 'bytes'}
                    or not isinstance(first['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', first['sha256'])
                    or type(first['bytes']) is not int or not 0 < first['bytes'] <= 512 * 1024):
                raise HealthError()
            # Hashing pages and backup files remains the job of backup.py --check.
            pages = path / '.backup-manifest-pages'
            support.directory(pages, private=True, root_owned=True)
            page = support.regular(pages / (first['sha256'] + '.json'), private=True, root_owned=True)
            if page.st_size != first['bytes']:
                raise HealthError()
        else:
            raise HealthError()
        newest = max(newest or 0, stamp.timestamp())
        report['backups']['completedSnapshots'] += 1
    if newest is None:
        add_check(report, 'backups.completed', 'warning'); return
    age = now - newest
    report['backups']['newestAgeHours'] = round(max(0, age) / 3600, 2)
    add_check(report, 'backups.completed', 'warning' if age > 36 * 3600 or age < -300 else 'ok')


def collect(now=None):
    report = {'status': 'ok', 'checks': [], 'services': {}}
    for name, operation in [('state.readable', lambda: state_check(report)),
                            ('disk.space', lambda: disk_check(report)),
                            ('service.companion', lambda: service_check(report, 'companion', support.UNIT, required=True)),
                            ('service.vpn', lambda: service_check(report, 'vpn', 'anchor-recall-vpn.service')),
                            ('service.backup-timer', lambda: service_check(report, 'backup-timer', 'anchor-recall-backup.timer')),
                            ('backups.readable', lambda: backups_check(report, time.time() if now is None else now))]:
        try:
            operation()
        except Exception:
            # Never serialize filesystem exceptions, systemctl output or journal contents.
            add_check(report, name, 'critical')
    report['status'] = max((row['status'] for row in report['checks']), key=LEVELS.__getitem__)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Read aggregate capacity, service and backup status; never change files or services.')
    args = parser.parse_args(argv)
    if not args.check:
        parser.print_help(); return 0
    if platform.system() != 'Linux' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        report = {'status': 'critical', 'checks': [{'name': 'requires-linux-root', 'status': 'critical'}]}
    else:
        report = collect()
    print(json.dumps(report, ensure_ascii=True, sort_keys=True))
    return LEVELS[report['status']]


if __name__ == '__main__':
    sys.exit(main())
