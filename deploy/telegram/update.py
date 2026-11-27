#!/usr/bin/env python3
"""Update an existing native companion; never rerun the fresh-install wizard."""
import argparse
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import stat
import subprocess
import tempfile
import time

APP = Path('/opt/anchor-recall-companion')
CONFIG = Path('/etc/anchor-recall-companion/config.json')
STATE = Path('/var/lib/anchor-recall-companion')
UNIT = 'anchor-recall-companion.service'
UNIT_FILE = Path('/etc/systemd/system') / UNIT
USER = 'anchor-recall'
BACKUPS = Path('/var/backups')
STAGING = Path('/var/tmp')
FILES = ('anchor-recall-companion.cjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}


class UpdateError(Exception):
    """Only static, secret-free messages may cross this boundary."""


def regular(path, private=False, root_owned=False):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or
            private and info.st_mode & 0o077 or
            root_owned and (info.st_uid != 0 or info.st_mode & 0o022)):
        raise UpdateError('Unsafe file metadata; existing files were preserved.')
    return info


def directory(path, private=False, root_owned=False):
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or path.resolve() != path.absolute() or
            private and info.st_mode & 0o077 or
            root_owned and (info.st_uid != 0 or info.st_mode & 0o022)):
        raise UpdateError('Unsafe directory metadata; existing files were preserved.')


def digest(path):
    regular(path)
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


CATALOG_LIMIT = 256 * 1024 * 1024
CATALOG_JOURNAL_FORMAT = 'anchor-recall-journal-v2'
PAGED_JOURNAL_FORMAT = 'anchor-recall-journal-v3'
PAGED_GATEWAY_FORMAT = 'anchor-recall-gateway-v2'
CATALOG_PAGE_LIMIT = 512 * 1024
CATALOG_PAGE_CHILDREN = 256


def private_descriptor(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077:
        raise UpdateError('Invalid private catalog or journal.')


def private_json_bytes(path, maximum):
    regular(path, private=True)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        private_descriptor(before)
        if before.st_size > maximum:
            raise UpdateError('Invalid private catalog or journal.')
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        private_descriptor(after)
        if (len(raw) > maximum
                or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise UpdateError('Private catalog changed while being read.')
    def pairs(rows):
        result = {}
        for key, item in rows:
            if key in result:
                raise UpdateError('Duplicate private catalog field.')
            result[key] = item
        return result
    def constant(_):
        raise UpdateError('Invalid private catalog number.')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, dict):
        raise UpdateError('Invalid private catalog object.')
    return value, raw


def read_catalog_blob(path, reference=None):
    directory(path.parent, private=True)
    if not path.parent.name.endswith('.blobs') or not re.fullmatch(r'[a-f0-9]{64}\.json', path.name):
        raise UpdateError('Invalid private catalog path.')
    value, raw = private_json_bytes(path, CATALOG_LIMIT)
    checksum = hashlib.sha256(raw).hexdigest()
    if checksum != path.stem or reference is not None and (checksum != reference['sha256'] or len(raw) != reference['bytes']):
        raise UpdateError('Private catalog checksum mismatch.')
    if value.get('version') != 1 or not isinstance(value.get('cards'), list):
        raise UpdateError('Invalid private catalog schema.')
    return value, len(raw)


def page_reference(value):
    if (not isinstance(value, dict) or set(value) != {'sha256', 'bytes', 'count'}
            or not isinstance(value['sha256'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['sha256'])
            or type(value['bytes']) is not int or not 0 < value['bytes'] <= CATALOG_PAGE_LIMIT
            or type(value['count']) is not int or not 0 <= value['count'] <= 9007199254740991):
        raise UpdateError('Invalid private catalog page reference.')


def read_catalog_page(path, reference=None):
    directory(path.parent, private=True)
    if not path.parent.name.endswith('.pages') or not re.fullmatch(r'[a-f0-9]{64}\.json', path.name):
        raise UpdateError('Invalid private catalog page path.')
    value, raw = private_json_bytes(path, CATALOG_PAGE_LIMIT)
    checksum = hashlib.sha256(raw).hexdigest()
    if checksum != path.stem:
        raise UpdateError('Private catalog page checksum mismatch.')
    if reference is not None:
        page_reference(reference)
        if checksum != reference['sha256'] or len(raw) != reference['bytes']:
            raise UpdateError('Private catalog page reference differs.')
    if value.get('version') != 1:
        raise UpdateError('Invalid private catalog page version.')
    kind, count = value.get('kind'), None
    if kind in ('records', 'list'):
        if set(value) != {'version', 'kind', 'values'} or not isinstance(value['values'], list):
            raise UpdateError('Invalid private catalog page records.')
        count = len(value['values'])
    elif kind == 'index':
        if (set(value) != {'version', 'kind', 'children'} or not isinstance(value['children'], list)
                or len(value['children']) > CATALOG_PAGE_CHILDREN):
            raise UpdateError('Invalid private catalog page index.')
        for child in value['children']:
            page_reference(child)
        count = sum(child['count'] for child in value['children'])
    elif kind == 'json':
        if set(value) != {'version', 'kind', 'value'}:
            raise UpdateError('Invalid private JSON page.')
        count = 1
    elif kind == 'array':
        if (set(value) != {'version', 'kind', 'parts'} or not isinstance(value['parts'], list)
                or len(value['parts']) > CATALOG_PAGE_CHILDREN):
            raise UpdateError('Invalid private JSON array page.')
        count = 0
        for part in value['parts']:
            if not isinstance(part, dict) or set(part) != {'reference', 'spread'} or type(part['spread']) is not bool:
                raise UpdateError('Invalid private JSON array part.')
            page_reference(part['reference'])
            count += part['reference']['count'] if part['spread'] else 1
    elif kind == 'object':
        if (set(value) != {'version', 'kind', 'members'} or not isinstance(value['members'], list)
                or len(value['members']) > CATALOG_PAGE_CHILDREN):
            raise UpdateError('Invalid private JSON object page.')
        names = set()
        for member in value['members']:
            if (not isinstance(member, dict) or set(member) != {'name', 'reference'}
                    or not isinstance(member['name'], str) or member['name'] in names):
                raise UpdateError('Invalid private JSON member.')
            names.add(member['name']); page_reference(member['reference'])
        count = 1
    else:
        raise UpdateError('Invalid private catalog page kind.')
    if count > 9007199254740991 or reference is not None and count != reference['count']:
        raise UpdateError('Invalid private catalog page count.')
    return value


def page_value(reference, pages, ancestors):
    page_reference(reference)
    if len(ancestors) >= 64 or reference['sha256'] in ancestors:
        raise UpdateError('Invalid private catalog page tree.')
    value = read_catalog_page(pages / (reference['sha256'] + '.json'), reference)
    return value, ancestors | {reference['sha256']}


def read_paged_list(reference, pages, kind='list', ancestors=frozenset(), seen=None):
    seen = set() if seen is None else seen
    page_reference(reference)
    if reference['sha256'] in seen:
        raise UpdateError('Repeated private catalog collection page.')
    seen.add(reference['sha256'])
    value, parents = page_value(reference, pages, ancestors)
    if value['kind'] == kind:
        return value['values']
    if value['kind'] != 'index':
        raise UpdateError('Private catalog page kind differs.')
    result = []
    for child in value['children']:
        result.extend(read_paged_list(child, pages, kind, parents, seen))
    if len(result) != reference['count']:
        raise UpdateError('Private catalog collection count differs.')
    return result


def read_paged_json(reference, pages, ancestors=frozenset()):
    value, parents = page_value(reference, pages, ancestors)
    if value['kind'] == 'json':
        return value['value']
    if value['kind'] == 'list':
        return value['values']
    if value['kind'] == 'object':
        return {member['name']: read_paged_json(member['reference'], pages, parents) for member in value['members']}
    if value['kind'] != 'array':
        raise UpdateError('Invalid private JSON tree.')
    result = []
    for part in value['parts']:
        child = read_paged_json(part['reference'], pages, parents)
        if part['spread']:
            if not isinstance(child, list):
                raise UpdateError('Invalid private JSON array segment.')
            result.extend(child)
        else:
            result.append(child)
    if len(result) != reference['count']:
        raise UpdateError('Private JSON array count differs.')
    return result


def hydrate_gateway_journal(value, path):
    if 'format' not in value:
        return value
    if set(value) != {'format', 'state'} or value['format'] != PAGED_GATEWAY_FORMAT:
        raise UpdateError('Invalid private paged gateway journal.')
    state = read_paged_json(value['state'], Path(str(path) + '.pages'))
    lists = ('pairs', 'accounts', 'inbox', 'notices', 'disconnects', 'pairStarts')
    integers = ('cursor', 'lastUpdateAt', 'timeFloor')
    if (not isinstance(state, dict) or set(state) != {'version', 'botId', *lists, *integers}
            or type(state['version']) is not int or state['version'] != 1
            or not isinstance(state['botId'], str) or not re.fullmatch(r'[0-9]+', state['botId'])
            or any(not isinstance(state[field], list) for field in lists)
            or any(type(state[field]) is not int or not 0 <= state[field] <= 9007199254740991 for field in integers)):
        raise UpdateError('Invalid private gateway state.')
    return state


def check_existing_gateway():
    path = STATE / 'gateway.json'
    if path.exists() or path.is_symlink():
        value, _ = private_json_bytes(path, 20_000_000)
        hydrate_gateway_journal(value, path)


def read_paged_collection(value, pages):
    if not isinstance(value, dict) or set(value) != {'records', 'order', 'count'} or type(value['count']) is not int or value['count'] < 0:
        raise UpdateError('Invalid private catalog collection.')
    page_reference(value['records']); page_reference(value['order'])
    if value['records']['count'] != value['count'] or value['order']['count'] != value['count']:
        raise UpdateError('Private catalog collection count differs.')
    rows = {}
    for row in read_paged_list(value['records'], pages, 'records'):
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or row['id'] in rows:
            raise UpdateError('Invalid private catalog record identity.')
        rows[row['id']] = row
    order = read_paged_list(value['order'], pages)
    if any(not isinstance(identity, str) for identity in order) or len(set(order)) != len(order) or set(order) != set(rows):
        raise UpdateError('Invalid private catalog record order.')
    return [rows[identity] for identity in order]


def read_paged_catalog(value, pages):
    if (not isinstance(value, dict) or value.get('version') != 1
            or not {'version', 'snapshot', 'consentIds', 'timeZone'}.issubset(value)
            or not set(value).issubset({'version', 'snapshot', 'context', 'consentIds', 'materialConsentIds', 'timeZone', 'attachmentConsent', 'offlineConsent'})):
        raise UpdateError('Invalid private paged catalog.')
    snapshot = value['snapshot']
    if (not isinstance(snapshot, dict) or not {'header', 'cards'}.issubset(snapshot)
            or not set(snapshot).issubset({'header', 'cards', 'targetCardIds'}) or not isinstance(snapshot['header'], dict)
            or snapshot['header'].get('version') != 1 or 'cards' in snapshot['header']):
        raise UpdateError('Invalid private paged snapshot.')
    result = {'snapshot': {**snapshot['header'], 'cards': read_paged_collection(snapshot['cards'], pages)}}
    if 'studyTarget' in snapshot['header']:
        if 'targetCardIds' not in snapshot or not isinstance(snapshot['header']['studyTarget'], dict):
            raise UpdateError('Invalid private paged study target.')
        result['snapshot']['studyTarget'] = {**snapshot['header']['studyTarget'], 'cardIds': read_paged_list(snapshot['targetCardIds'], pages)}
    elif 'targetCardIds' in snapshot:
        raise UpdateError('Ambiguous private study target.')
    if 'context' in value:
        context = value['context']
        if (not isinstance(context, dict) or set(context) != {'header', 'cards'} or not isinstance(context['header'], dict)
                or context['header'].get('version') != 1 or 'cards' in context['header']):
            raise UpdateError('Invalid private paged study context.')
        result['context'] = {**context['header'], 'cards': read_paged_collection(context['cards'], pages)}
    read_paged_list(value['consentIds'], pages)
    if 'materialConsentIds' in value:
        read_paged_list(value['materialConsentIds'], pages)
    return result


def hydrate_catalog_journal(value, path):
    if value.get('format') == PAGED_JOURNAL_FORMAT:
        if not {'format', 'state'}.issubset(value) or not set(value).issubset({'format', 'state', 'catalog'}):
            raise UpdateError('Invalid private paged journal.')
        pages = Path(str(path) + '.pages')
        state = read_paged_json(value['state'], pages)
        if (not isinstance(state, dict) or state.get('version') != 1 or not isinstance(state.get('domain'), dict)
                or state['domain'].get('version') != 1 or 'snapshot' in state['domain'] or 'studyContext' in state):
            raise UpdateError('Ambiguous private paged journal.')
        if 'catalog' in value:
            catalog = read_paged_catalog(value['catalog'], pages)
            if 'catalogRoot' in state:
                published = state['catalogRoot']
                if (not isinstance(published, dict) or published.get('snapshot') != value['catalog'].get('snapshot')
                        or published.get('context') != value['catalog'].get('context')):
                    raise UpdateError('Private catalog publication pointer differs.')
                read_paged_list(published['consentIds'], pages)
                if 'materialConsentIds' in published:
                    read_paged_list(published['materialConsentIds'], pages)
            state['domain']['snapshot'] = catalog['snapshot']
            if 'context' in catalog:
                state['studyContext'] = catalog['context']
        return state, 0
    if value.get('format') != CATALOG_JOURNAL_FORMAT:
        return value, 0
    if not {'format', 'state'}.issubset(value) or not set(value).issubset({'format', 'state', 'snapshot', 'studyContext'}):
        raise UpdateError('Invalid catalog journal envelope.')
    state = value['state']
    if (not isinstance(state, dict) or state.get('version') != 1 or not isinstance(state.get('domain'), dict)
            or state['domain'].get('version') != 1 or 'snapshot' in state['domain'] or 'studyContext' in state):
        raise UpdateError('Ambiguous catalog journal.')
    state = {**state, 'domain': dict(state['domain'])}
    total = 0
    for key in ('snapshot', 'studyContext'):
        if key not in value:
            continue
        reference = value[key]
        if (not isinstance(reference, dict) or set(reference) != {'sha256', 'bytes'} or not isinstance(reference['sha256'], str)
                or not re.fullmatch(r'[a-f0-9]{64}', reference['sha256']) or type(reference['bytes']) is not int or not 0 < reference['bytes'] <= CATALOG_LIMIT):
            raise UpdateError('Invalid private catalog reference.')
        content, size = read_catalog_blob(Path(str(path) + '.blobs') / (reference['sha256'] + '.json'), reference)
        if key == 'snapshot':
            state['domain']['snapshot'] = content
        else:
            state['studyContext'] = content
        total += size
    return state, total


def verify_artifact(package):
    manifest = package / 'SHA256SUMS'
    if regular(manifest).st_size > 32768:
        raise UpdateError('Oversized artifact manifest.')
    hashes = {}
    for line in manifest.read_text('utf-8').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
        if not match or match[2] in hashes:
            raise UpdateError('Invalid artifact checksum manifest.')
        hashes[match[2]] = match[1]
    result = {}
    for name in FILES:
        source = package / name
        if regular(source).st_size > 64 * 1024 * 1024:
            raise UpdateError('Oversized release asset.')
        result[name] = source.read_bytes()
        if hashlib.sha256(result[name]).hexdigest() != hashes.get(name):
            raise UpdateError('Release checksum failed. Obtain the complete trusted package again.')
    return result


def run(args, timeout=30):
    try:
        result = subprocess.run([str(a) for a in args], check=True, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, env=ENV, text=True)
        return result.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise UpdateError('A required system check failed; sensitive command details were withheld.') from None


def resolve_node():
    regular(UNIT_FILE, root_owned=True)
    values, section = {}, ''
    for line in UNIT_FILE.read_text('utf-8').splitlines():
        line = line.strip()
        if line.startswith('['):
            section = line
        elif section == '[Service]' and line and not line.startswith(('#', ';')):
            key, separator, value = line.partition('=')
            if separator and key in ('ExecStart', 'User', 'Group', 'WorkingDirectory'):
                if key in values or line.endswith('\\'):
                    raise UpdateError('The service command is ambiguous; use a reviewed manual update.')
                values[key] = value
    args = shlex.split(values.get('ExecStart', ''))
    if (values.get('User') != USER or values.get('Group') != USER or
            values.get('WorkingDirectory') != str(APP) or len(args) != 4 or
            args[1:] != [str(APP / FILES[0]), '--config', str(CONFIG)]):
        raise UpdateError('The owned service differs from the supported native installation.')
    node = Path(args[0])
    if not node.is_absolute() or node.name != 'node' or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(node)):
        raise UpdateError('An absolute trusted Node executable is required.')
    for entry in (node, *node.parents, node.resolve(), *node.resolve().parents):
        info = entry.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise UpdateError('The installed Node path is not privately controlled by root.')
    expected = '{ path=' + str(node) + ' ; argv[]=' + ' '.join(args) + ' ;'
    effective = run(['systemctl', 'show', UNIT, '--property=ExecStart', '--value'])
    if not effective.startswith(expected) or effective.count('{ path=') != 1 or run([
            'systemctl', 'show', UNIT, '--property=User', '--value']) != USER:
        raise UpdateError('The effective service command differs from its owned unit.')
    version = re.fullmatch(r'v(\d+)\.\d+\.\d+', run([node, '--version']))
    if not version or int(version[1]) < 24:
        raise UpdateError('The installed service requires Node 24 or newer.')
    return node


def state_paths():
    directory(STATE, private=True)
    result = [STATE]
    for path in sorted(STATE.rglob('*')):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            directory(path, private=True)
        else:
            regular(path, private=True)
        result.append(path)
    return result


def protected_fingerprint():
    regular(CONFIG, private=True)
    rows = [('config', digest(CONFIG))]
    for path in state_paths():
        info = path.lstat()
        rows.append((str(path.relative_to(STATE)), stat.S_IMODE(info.st_mode), info.st_uid,
                     'directory' if path.is_dir() else digest(path)))
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()


def copy_private(source, destination):
    regular(source)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'wb') as target, source.open('rb') as stream:
        os.chmod(destination, 0o600)
        shutil.copyfileobj(stream, target)
        target.flush()
        os.fsync(target.fileno())
    if digest(source) != digest(destination):
        raise UpdateError('Private backup verification failed; source data was not replaced.')


def backup_current():
    directory(BACKUPS, root_owned=True)
    backup = Path(tempfile.mkdtemp(prefix='anchor-recall-before-update-', dir=BACKUPS))
    backup.chmod(0o700)
    print('Создаём закрытую резервную копию: ' + str(backup))
    copy_private(CONFIG, backup / 'config.json')
    for name in FILES:
        copy_private(APP / name, backup / name)
    for source in state_paths():
        target = backup / 'state' / source.relative_to(STATE)
        if source.is_dir():
            target.mkdir(mode=0o700)
            target.chmod(0o700)
        else:
            copy_private(source, target)
    return backup


def replace_asset(name, data):
    if name not in FILES:
        raise UpdateError('Only the three public release assets may be replaced.')
    regular(APP / name, root_owned=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.companion-update-', dir=APP)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.chmod(temporary, 0o644)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, APP / name)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def assets_owned(previous, release, replaced):
    try:
        for name in FILES:
            regular(APP / name, root_owned=True)
            if (APP / name).read_bytes() != (release[name] if name in replaced else previous[name]):
                return False
        return True
    except OSError:
        return False
    except UpdateError:
        return False


def stop_service():
    run(['systemctl', 'stop', UNIT], timeout=60)
    if run(['systemctl', 'show', UNIT, '--property=MainPID', '--value']) != '0':
        raise UpdateError('The companion did not stop cleanly; preserve all journals and locks.')


def probe_service(host):
    deadline, consecutive = time.monotonic() + 20, 0
    while time.monotonic() < deadline:
        if run(['systemctl', 'show', UNIT, '--property=ActiveState', '--value']) == 'active':
            connection = http.client.HTTPConnection(host, 8787, timeout=3)
            try:
                connection.request('POST', '/pair/start', body='{}', headers={'Content-Type': 'application/json'})
                response = connection.getresponse()
                consecutive = consecutive + 1 if response.status == 400 else 0
                response.read(1024)
            except (OSError, http.client.HTTPException):
                consecutive = 0
            finally:
                connection.close()
            if consecutive >= 3:
                return
        else:
            consecutive = 0
        time.sleep(1)
    raise UpdateError('The updated service/local bridge did not become ready; Telegram delivery was not tested.')


def apply_update(package, check_only=False):
    release = verify_artifact(package)
    directory(APP, root_owned=True)
    if regular(CONFIG, private=True).st_size > 16384:
        raise UpdateError('Oversized private configuration.')
    directory(STATE, private=True)
    node = resolve_node()
    config = json.loads(CONFIG.read_text('utf-8'))
    host = config.get('host', '127.0.0.1')
    address = ipaddress.ip_address('127.0.0.1' if host == 'localhost' else host)
    local = address.is_loopback or address.version == 4 and any(address in ipaddress.IPv4Network(network)
        for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))
    if (config.get('stateDirectory') != str(STATE) or config.get('port', 8787) != 8787 or not local):
        raise UpdateError('The existing private listener/state layout is not supported by this helper.')
    previous = {name: (regular(APP / name, root_owned=True), (APP / name).read_bytes())[1] for name in FILES}
    stage = Path(tempfile.mkdtemp(prefix='anchor-recall-update-', dir=STAGING))
    stage.chmod(0o755)
    stopped, baseline, backup, replaced = False, None, None, set()
    try:
        for name, data in release.items():
            (stage / name).write_bytes(data)
            (stage / name).chmod(0o644)
        run(['runuser', '--user', USER, '--', node, stage / FILES[0], '--check', '--config', CONFIG])
        check_existing_gateway()
        if check_only:
            print('Пакет и конфигурация проверены офлайн. Служба и данные не изменены.')
            return None
        stop_service()
        stopped = True
        paths = state_paths()
        if any(path.name.endswith('.lock') for path in paths):
            raise UpdateError('A journal lock remains after stopping. It was not removed or stolen.')
        check_existing_gateway()
        baseline = protected_fingerprint()
        backup = backup_current()
        if protected_fingerprint() != baseline or any((APP / name).read_bytes() != data for name, data in previous.items()):
            raise UpdateError('Protected state or installed code changed during backup; activation refused.')
        for name, data in release.items():
            if not assets_owned(previous, release, replaced):
                raise UpdateError('Installed code changed concurrently; external changes were preserved.')
            if data == previous[name]:
                continue
            replace_asset(name, data)
            replaced.add(name)
        if protected_fingerprint() != baseline or not assets_owned(previous, release, replaced):
            raise UpdateError('Protected state or code changed while stopped; activation refused.')
        run(['systemctl', 'start', UNIT], timeout=60)
        probe_service(str(address))
        print('Обновление установлено: служба активна, локальный мост отвечает. Доставка Telegram требует отдельной проверки.')
        print('Закрытая резервная копия: ' + str(backup))
        return backup
    except Exception as error:
        if isinstance(error, UpdateError):
            print(str(error))
        if stopped:
            try:
                stop_service()
                unchanged = baseline is not None and protected_fingerprint() == baseline and assets_owned(previous, release, replaced)
            except Exception:
                unchanged = False
            if unchanged:
                pending = set(replaced)
                for name in FILES:
                    if name not in pending:
                        continue
                    if protected_fingerprint() != baseline or not assets_owned(previous, release, pending):
                        raise UpdateError('Rollback stopped after a concurrent change; preserve the backup for manual recovery.')
                    replace_asset(name, previous[name])
                    pending.remove(name)
                print('Прежние файлы программы восстановлены. Служба оставлена остановленной; данные не восстанавливались.')
            else:
                print('Состояние или файлы программы изменились либо не подтверждены. Автоматического отката нет; сохраните копию для ручного восстановления.')
            if backup is not None:
                print('Сохраните текущее состояние и резервную копию для ручного восстановления: ' + str(backup))
        raise UpdateError('Обновление не завершено. Секреты и содержимое журналов не выводятся.') from None
    finally:
        try:
            for name in FILES:
                (stage / name).unlink(missing_ok=True)
            stage.rmdir()
        except OSError:
            print('Временная папка с публичным кодом сохранена; конфигурации и журналов в ней нет.')


def update(package, check_only=False):
    if platform.system() != 'Linux' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise UpdateError('Run sudo python3 update.py on the Debian server.')
    import fcntl
    descriptor = os.open('/run/lock/anchor-recall-companion-update.lock',
                         os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise UpdateError('The operator update lock is unsafe; it was preserved.')
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise UpdateError('Another companion update is running; nothing was stopped.') from None
        return apply_update(package, check_only)
    finally:
        os.close(descriptor)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate package/config offline without stopping the service.')
    args = parser.parse_args(argv)
    try:
        update(Path(__file__).resolve().parent, args.check)
        return 0
    except UpdateError as error:
        print(str(error))
        return 1
    except Exception:
        print('Обновление остановлено. Проверьте службу и закрытую резервную копию; конфигурация и журналы не перезаписывались.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
