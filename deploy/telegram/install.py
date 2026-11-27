#!/usr/bin/env python3
"""Fresh-install wizard for the standalone Anchor Recall Telegram companion."""
import argparse
import errno
import getpass
import hashlib
import io
import itertools
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import socket
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import urllib.error
import warnings

APP = Path('/opt/anchor-recall-companion')
CONFIG = Path('/etc/anchor-recall-companion/config.json')
STATE = Path('/var/lib/anchor-recall-companion')
WEBROOT = Path('/var/www/anchor-recall-acme')
SITE = Path('/etc/nginx/sites-available/anchor-recall-companion')
SITE_LINK = Path('/etc/nginx/sites-enabled/anchor-recall-companion')
SYSTEMD = Path('/etc/systemd/system')
CERT_NAME = 'anchor-recall-ip'
CERT_DIR = Path('/etc/letsencrypt/live') / CERT_NAME
DEPLOY_HOOK = Path('/etc/letsencrypt/renewal-hooks/deploy/anchor-recall-companion')
USER = 'anchor-recall'
SERVICE = 'anchor-recall-companion.service'
RENEW = 'anchor-recall-certificate'
NODE_VERSION = '24.22.2'
# Pins authenticated against the Node release team's signed SHA256 manifest.
NODE_HASHES = {
    'x64': '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75',
    'arm64': 'eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8',
}
SAFE_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8',
            'DEBIAN_FRONTEND': 'noninteractive', 'PIP_CONFIG_FILE': '/dev/null',
            'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
PLAN = ('Установим nginx, подходящий Node.js и Certbot; получим HTTPS-сертификат '
        'для вашего IP; создадим закрытую конфигурацию и отдельного системного '
        'пользователя; включим бота и проверку продления сертификата дважды в день. '
        'Порты 80 и 443 должны вести на этот ноутбук. Существующие установки не заменяем.')
BACKEND_PLAN = ('Установим только Node.js и службу бота на указанном частном IPv4, порт 8787. '
                'Существующие nginx, Docker, HTTPS и сертификаты не меняем. '
                'Публичный HTTPS нужно отдельно настроить в вашем обратном прокси '
                'до подключения Obsidian.')


class InstallerError(Exception):
    """Safe, operator-facing error; never include credentials or response bodies."""


def validate_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
        if not address.is_global or address.is_multicast:
            raise ValueError()
        return str(address)
    except (ValueError, ipaddress.AddressValueError):
        raise InstallerError('Enter a public IPv4 address, not a private/local address.') from None


def validate_bot_token(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,19}:[A-Za-z0-9_-]{20,256}', value):
        raise InstallerError('Invalid bot token format. Copy the token from BotFather.')
    return value


def validate_private_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
        if not any(address in ipaddress.IPv4Network(network)
                   for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
            raise ValueError()
        return str(address)
    except (ValueError, ipaddress.AddressValueError):
        raise InstallerError('Укажите частный IPv4 интерфейса: 10.x.x.x, 172.16–31.x.x или 192.168.x.x.') from None


def parse_version(value):
    match = re.fullmatch(r'(?:v|certbot )?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*', value)
    if not match:
        raise InstallerError('The installed program returned an unrecognized version.')
    return tuple(map(int, match.groups()))


def run(argv, timeout=600):
    command = [str(item) for item in argv]
    program = Path(command[0]).name
    label = program if program in {'apt-get', 'nginx', 'node', 'certbot', 'python3', 'python',
                                  'useradd', 'runuser', 'systemd-analyze', 'systemctl'} else 'external program'
    if program == 'systemctl' and tuple(command[1:]) in {
            ('enable', '--now', 'nginx'), ('reload', 'nginx'), ('daemon-reload',),
            ('enable', '--now', 'anchor-recall-certificate.timer'),
            ('enable', '--now', 'anchor-recall-companion.service')}:
        label = 'systemctl ' + ' '.join(command[1:])
    try:
        result = subprocess.run(command, check=True, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, env=SAFE_ENV, text=True)
        return result.stdout[:262144]
    except (OSError, subprocess.SubprocessError) as error:
        detail = ' (timeout)' if isinstance(error, subprocess.TimeoutExpired) else ''
        if isinstance(error, subprocess.CalledProcessError) and type(error.returncode) is int:
            detail = ' (exit ' + str(error.returncode) + ')'
        raise InstallerError('A system command failed: ' + label + detail +
                             '. No existing data was removed; inspect the installation before retrying.') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        try:
            fp.close()
        finally:
            raise InstallerError('An HTTPS request unexpectedly redirected; installation stopped.') from None


def download(url, max_bytes):
    if not url.startswith(('https://nodejs.org/', 'https://api.telegram.org/')):
        raise InstallerError('Unexpected download host.')
    host = 'api.telegram.org' if url.startswith('https://api.telegram.org/') else 'nodejs.org'
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'AnchorRecall-Installer/1'})
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise InstallerError('An HTTPS response exceeded the allowed size.')
        return data
    except InstallerError:
        raise
    except Exception as error:
        if isinstance(error, urllib.error.HTTPError):
            code = error.code if type(error.code) is int else None
            if host == 'api.telegram.org' and code in (401, 404):
                message = 'Telegram не принял ключ бота. Скопируйте токен из BotFather заново (HTTP ' + str(code) + ').'
            elif code == 429:
                message = host + ' временно ограничил запросы (HTTP 429). Повторите позже.'
            else:
                message = host + ' отклонил HTTPS-запрос' + (' (HTTP ' + str(code) + ')' if code else '') + '.'
            # HTTPError owns the response; implicit cleanup can warn with its token-bearing URL/reason.
            try:
                error.close()
            finally:
                raise InstallerError(message) from None
        else:
            reason = error.reason if isinstance(error, urllib.error.URLError) else error
            if isinstance(reason, ssl.SSLCertVerificationError):
                message = ('Не удалось проверить HTTPS-сертификат ' + host +
                           '. Проверьте дату на ноутбуке и пакет ca-certificates.')
            elif isinstance(reason, socket.gaierror):
                message = 'Не удалось определить адрес ' + host + ' (DNS). Проверьте настройки сети и DNS.'
            elif isinstance(reason, TimeoutError):
                message = 'Таймаут соединения с ' + host + '. Проверьте доступ к этому адресу из Debian.'
            else:
                message = 'Не удалось установить соединение с ' + host + ' по HTTPS. Проверьте сеть и настройки прокси.'
        # Exception text and request URLs can contain the bot token.
        raise InstallerError(message) from None


def bot_username(token):
    def api(method):
        try:
            value = json.loads(download('https://api.telegram.org/bot' + token + '/' + method, 65536))
            if value.get('ok') is not True or not isinstance(value.get('result'), dict):
                raise ValueError()
            return value['result']
        except InstallerError:
            raise
        except Exception:
            raise InstallerError('Telegram could not validate this bot. Check its token in BotFather.') from None
    bot = api('getMe')
    name = bot.get('username', '')
    if (bot.get('is_bot') is not True or type(bot.get('id')) is not int or
            str(bot['id']) != token.split(':')[0] or
            not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{4,31}', name)):
        raise InstallerError('Telegram returned an unexpected bot identity.')
    if api('getWebhookInfo').get('url') != '':
        raise InstallerError('This bot has an active webhook. Stop its previous server and remove that webhook explicitly before installing.')
    return name


def write_new(path, data, mode=0o644, uid=None, gid=None):
    """Publish a fully written file atomically, without replacing any destination."""
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.anchor-recall-', dir=path.parent)
        with os.fdopen(fd, 'wb') as stream:
            os.chmod(temporary, mode)
            if uid is not None:
                os.fchown(stream.fileno(), uid, gid)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path, follow_symlinks=False)
    except FileExistsError:
        raise InstallerError('An installation file already exists; it was preserved: ' + str(path)) from None
    finally:
        if temporary is not None:
            os.unlink(temporary)


def trusted_executable(path):
    try:
        resolved = path.resolve(strict=True)
        for candidate in (path, *path.parents, resolved, *resolved.parents):
            info = candidate.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                return False
        return stat.S_ISREG(resolved.stat().st_mode) and os.access(resolved, os.X_OK)
    except OSError:
        return False


def trusted_tree(path):
    """A reused virtualenv also imports modules outside its bin directory."""
    try:
        for count, child in enumerate(itertools.chain((path,), path.rglob('*'))):
            info = child.lstat()
            if (count >= 50000 or info.st_uid != 0 or
                    not child.is_symlink() and info.st_mode & 0o022):
                return False
            if child.is_symlink():
                resolved = child.resolve(strict=True)
                if any(p.stat().st_uid != 0 or p.stat().st_mode & 0o022
                       for p in (resolved, *resolved.parents)):
                    return False
        return True
    except OSError:
        return False


def extract_node(archive, destination, expected_sha256, architecture):
    if hashlib.sha256(archive).hexdigest() != expected_sha256:
        raise InstallerError('Node archive checksum did not match the authenticated release pin.')
    wanted = f'node-v{NODE_VERSION}-linux-{architecture}/bin/node'
    license_name = f'node-v{NODE_VERSION}-linux-{architecture}/LICENSE'
    binary = None
    license_text = None
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:xz') as bundle:
            count, total = 0, 0
            for member in bundle:
                count, total = count + 1, total + member.size
                path = PurePosixPath(member.name)
                if (count > 20000 or total > 512 * 1024 * 1024 or path.is_absolute() or
                        '..' in path.parts or '\\' in member.name):
                    raise InstallerError('Unsafe or oversized Node archive.')
                # npm/npx symlinks are deliberately not extracted; this service needs only node.
                if member.name == wanted:
                    if binary is not None or not member.isfile() or member.size > 256 * 1024 * 1024:
                        raise InstallerError('Node executable must be a single regular file.')
                    stream = bundle.extractfile(member)
                    binary = stream.read(member.size + 1)
                    if len(binary) != member.size:
                        raise InstallerError('Incomplete Node executable.')
                elif member.name == license_name:
                    if license_text is not None or not member.isfile() or member.size > 1024 * 1024:
                        raise InstallerError('Invalid Node license file.')
                    license_text = bundle.extractfile(member).read(member.size + 1)
        if not binary or not binary.startswith(b'\x7fELF'):
            raise InstallerError('The Node archive contains no valid Linux executable.')
    except InstallerError:
        raise
    except Exception:
        raise InstallerError('The Node archive could not be safely read.') from None
    destination.mkdir(mode=0o755)
    (destination / 'bin').mkdir(mode=0o755)
    destination.chmod(0o755)
    (destination / 'bin').chmod(0o755)
    executable = destination / 'bin/node'
    write_new(executable, binary, 0o755)
    if license_text is not None:
        write_new(destination / 'LICENSE', license_text)
    return executable


def verify_package(package):
    names = ['anchor-recall-companion.cjs', 'anchor-recall-companion.service',
             'LICENSE', 'THIRD_PARTY_NOTICES.md', 'config.example.json']
    manifest = package / 'SHA256SUMS'
    if manifest.is_symlink() or not manifest.is_file() or manifest.stat().st_size > 32768:
        raise InstallerError('Run this installer from the extracted, complete server package.')
    hashes = {}
    for line in manifest.read_text('utf-8').splitlines():
        match = re.fullmatch(r'([a-f0-9]{64})  ([A-Za-z0-9_.-]+)', line)
        if not match or match[2] in hashes:
            raise InstallerError('Invalid server package checksum manifest.')
        hashes[match[2]] = match[1]
    for name in names:
        path = package / name
        if (path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024 * 1024 or
                hashlib.sha256(path.read_bytes()).hexdigest() != hashes.get(name)):
            raise InstallerError('The server package is incomplete or its checksum failed: ' + name)
    return names


def http_site(ip):
    return (f'# Anchor Recall installer: HTTP challenge only\nserver {{\n    listen 80;\n'
            f'    server_name {ip};\n    location /.well-known/acme-challenge/ {{ root {WEBROOT}; }}\n'
            '    location / { return 404; }\n}\n').encode()


def check_nginx(ip):
    if SITE.is_symlink() or (SITE.exists() and SITE.read_bytes() != http_site(ip)):
        raise InstallerError('The companion nginx site already exists with different contents; it was preserved.')
    if SITE_LINK.is_symlink():
        if SITE_LINK.resolve() != SITE or not SITE.is_file():
            raise InstallerError('The companion nginx link points elsewhere.')
    elif SITE_LINK.exists():
        raise InstallerError('The companion nginx site link is occupied.')
    main = Path('/etc/nginx/nginx.conf')
    if main.exists():
        active = '\n'.join(line.split('#', 1)[0] for line in main.read_text().splitlines())
        allowed = {'/etc/nginx/modules-enabled/*.conf', '/etc/nginx/mime.types',
                   '/etc/nginx/conf.d/*.conf', '/etc/nginx/sites-enabled/*'}
        if (re.search(r'\b(?:server\s*\{|listen\s+)', active) or
                any(value not in allowed for value in re.findall(r'\binclude\s+([^;]+);', active))):
            raise InstallerError('Custom nginx configuration is present; use the manual installation guide.')
    for folder in (Path('/etc/nginx/conf.d'), Path('/etc/nginx/sites-enabled')):
        if folder.exists():
            for path in folder.iterdir():
                if path == SITE_LINK or path.name == 'default' and folder.name == 'sites-enabled':
                    continue
                if path.is_file() or path.is_symlink():
                    raise InstallerError('Custom nginx configuration is present; use the manual installation guide to preserve it.')
    default = Path('/etc/nginx/sites-enabled/default')
    if default.exists():
        active = '\n'.join(line.split('#', 1)[0] for line in default.read_text().splitlines())
        if re.search(r'\blisten\s+[^;]*\b443\b', active):
            raise InstallerError('nginx already serves HTTPS; use the manual installation guide.')


def check_ports_available():
    for port in (80, 443):
        for family, address in ((socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
            try:
                with socket.socket(family, socket.SOCK_STREAM) as probe:
                    probe.bind((address, port))
            except OSError as error:
                if family == socket.AF_INET6 and error.errno in {
                        errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.ENOPROTOOPT, errno.EADDRNOTAVAIL}:
                    continue
                raise InstallerError('Порт ' + str(port) + ' занят или недоступен. '
                                     'Установщик ничего не останавливает; проверьте действующие службы '
                                     'и контейнеры перед установкой.') from None


def check_backend_port_available(address):
    address = validate_private_ipv4(address)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((address, 8787))
    except OSError:
        raise InstallerError('Частный адрес с портом 8787 недоступен: адрес должен принадлежать '
                             'этому ноутбуку, а порт должен быть свободен. Действующие службы не остановлены.') from None


def preflight(package, bind_address=None):
    if bind_address is not None:
        bind_address = validate_private_ipv4(bind_address)
    if platform.system() != 'Linux' or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        raise InstallerError('Run sudo python3 install.py on the Debian server, not on your desktop.')
    release = Path('/etc/os-release').read_text()[:16384]
    if not re.search(r'^ID=[\"\']?debian[\"\']?$', release, re.M):
        raise InstallerError('This wizard supports Debian 12 or newer. Use the manual guide on other systems.')
    version = re.search(r'^VERSION_ID=[\"\']?(\d+)', release, re.M)
    if not version or int(version[1]) < 12 or not Path('/run/systemd/system').is_dir():
        raise InstallerError('Debian 12 or newer running systemd is required.')
    if bind_address is None:
        check_ports_available()
    else:
        check_backend_port_available(bind_address)
    verify_package(package)
    import pwd
    import grp
    try:
        pwd.getpwnam(USER)
    except KeyError:
        pass
    else:
        raise InstallerError('The companion system account already exists; this wizard only performs fresh installations.')
    try:
        grp.getgrnam(USER)
    except KeyError:
        pass
    else:
        raise InstallerError('The companion system group already exists; it was preserved.')
    unit_names = (SERVICE,) if bind_address is not None else (SERVICE, RENEW + '.service', RENEW + '.timer')
    for directory in ('/usr/lib/systemd/system', '/lib/systemd/system', '/run/systemd/system'):
        for name in unit_names:
            for path in (Path(directory) / name, Path(directory) / (name + '.d')):
                if path.exists() or path.is_symlink():
                    raise InstallerError('An existing system service was preserved: ' + str(path))
    occupied_paths = [CONFIG.parent, STATE, SYSTEMD / SERVICE, SYSTEMD / (SERVICE + '.d')]
    if bind_address is None:
        occupied_paths.extend((SYSTEMD / (RENEW + '.service'), SYSTEMD / (RENEW + '.timer'), CERT_DIR,
                               DEPLOY_HOOK, CERT_DIR.parent.parent / 'renewal' / (CERT_NAME + '.conf'),
                               CERT_DIR.parent.parent / 'archive' / CERT_NAME))
    for path in occupied_paths:
        if path.exists() or path.is_symlink():
            raise InstallerError('An existing installation or certificate was preserved: ' + str(path))
    if APP.is_symlink() or (APP.exists() and (not APP.is_dir() or
            any(path.name not in ('node', 'certbot-venv') or path.is_symlink() for path in APP.iterdir()))):
        raise InstallerError('The application directory is occupied; use the manual guide.')
    for path in ((APP,) if bind_address is not None else (APP, WEBROOT, DEPLOY_HOOK.parent)):
        if path.exists() and (path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022):
            raise InstallerError('An installation directory is not privately controlled by root: ' + str(path))


def install(package, ip, token, username, bind_address=None):
    import pwd
    if bind_address is None:
        preflight(package)
        check_nginx(ip)
    else:
        bind_address = validate_private_ipv4(bind_address)
        preflight(package, bind_address)
    run(['apt-get', 'update'])
    dependencies = ['ca-certificates', 'xz-utils'] if bind_address is not None else [
        'nginx', 'python3-venv', 'ca-certificates', 'xz-utils', 'curl']
    run(['apt-get', 'install', '--yes', *dependencies])
    APP.mkdir(mode=0o755, exist_ok=True)
    APP.chmod(0o755)
    node = None
    for candidate in (Path('/usr/bin/node'), Path('/usr/local/bin/node'), APP / 'node/bin/node'):
        if trusted_executable(candidate) and parse_version(run([candidate, '--version'], 15)) >= (24, 0, 0):
            node = candidate.resolve()
            break
    if node is None:
        architecture = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
        if architecture is None:
            raise InstallerError('Automatic Node installation supports x86_64 and arm64 only.')
        filename = f'node-v{NODE_VERSION}-linux-{architecture}.tar.xz'
        node = extract_node(download('https://nodejs.org/dist/v' + NODE_VERSION + '/' + filename,
                                    128 * 1024 * 1024), APP / 'node', NODE_HASHES[architecture], architecture)
        if parse_version(run([node, '--version'], 15)) != (24, 22, 2):
            raise InstallerError('Unexpected Node runtime version.')
    certbot = None
    if bind_address is None:
        certbot = Path('/usr/bin/certbot')
        if not trusted_executable(certbot) or parse_version(run([certbot, '--version'], 15)) < (5, 4, 0):
            venv = APP / 'certbot-venv'
            if not venv.exists():
                run(['/usr/bin/python3', '-m', 'venv', venv])
            if not trusted_tree(venv) or not trusted_executable(venv / 'bin/python'):
                raise InstallerError('The private Certbot environment is not trusted.')
            run([venv / 'bin/python', '-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple', '--upgrade', 'pip'])
            run([venv / 'bin/python', '-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple', 'certbot>=5.4'])
            certbot = venv / 'bin/certbot'
            if parse_version(run([certbot, '--version'], 15)) < (5, 4, 0):
                raise InstallerError('Certbot 5.4 or newer is required for IP certificates.')
        check_nginx(ip)
        WEBROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
        WEBROOT.chmod(0o755)
        if not SITE.exists():
            write_new(SITE, http_site(ip))
        if not SITE_LINK.is_symlink():
            SITE_LINK.symlink_to(SITE)
        run(['nginx', '-t'], 30)
        run(['systemctl', 'enable', '--now', 'nginx'], 60)
        run(['systemctl', 'reload', 'nginx'], 60)
        DEPLOY_HOOK.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        hook = ('#!/bin/sh\nset -eu\ncase "${RENEWED_LINEAGE:-}" in\n    ' + shlex.quote(str(CERT_DIR)) +
                ') /usr/sbin/nginx -t; /bin/systemctl reload nginx ;;\nesac\n')
        write_new(DEPLOY_HOOK, hook.encode(), 0o755)
        run([certbot, 'certonly', '--non-interactive', '--agree-tos', '--register-unsafely-without-email',
             '--preferred-profile', 'shortlived', '--webroot', '--webroot-path', WEBROOT,
             '--ip-address', ip, '--cert-name', CERT_NAME])
        https = (http_site(ip).decode() + f'\nserver {{\n    listen 443 ssl;\n    server_name {ip};\n'
                 f'    ssl_certificate {CERT_DIR}/fullchain.pem;\n    ssl_certificate_key {CERT_DIR}/privkey.pem;\n'
                 '    ssl_protocols TLSv1.2 TLSv1.3;\n    client_max_body_size 512000;\n'
                 '    location / {\n        proxy_pass http://127.0.0.1:8787;\n'
                 '        proxy_set_header Host $host;\n        proxy_set_header X-Forwarded-Proto https;\n'
                 '        proxy_read_timeout 30s;\n    }\n}\n').encode()
        if SITE.is_symlink() or SITE.read_bytes() != http_site(ip):
            raise InstallerError('nginx configuration changed during installation; it was preserved.')
        temporary = SITE.with_name(SITE.name + '.https-new')
        write_new(temporary, https)
        os.replace(temporary, SITE)
        try:
            run(['nginx', '-t'], 30)
            run(['systemctl', 'reload', 'nginx'], 60)
        except InstallerError:
            if not SITE.is_symlink() and SITE.read_bytes() == https:
                write_new(temporary, http_site(ip))
                os.replace(temporary, SITE)
            raise
        run([certbot, 'renew', '--cert-name', CERT_NAME, '--dry-run', '--run-deploy-hooks'], 600)
    # Dependency checks (and TLS in normal mode) finish before enabling the bot.
    run(['useradd', '--system', '--user-group', '--home-dir', STATE, '--no-create-home', '--shell', '/usr/sbin/nologin', USER])
    account = pwd.getpwnam(USER)
    STATE.mkdir(mode=0o700)
    STATE.chmod(0o700)
    os.chown(STATE, account.pw_uid, account.pw_gid)
    CONFIG.parent.mkdir(mode=0o750)
    CONFIG.parent.chmod(0o750)
    os.chown(CONFIG.parent, 0, account.pw_gid)
    config = {'version': 1, 'enabled': True, 'botUsername': username, 'botToken': token,
              'stateDirectory': str(STATE), 'host': bind_address or '127.0.0.1', 'port': 8787, 'externalTlsProxy': True,
              'pairingTtlMinutes': 10, 'maxPendingPairings': 1000,
              'sessionsLocal': [540, 1140], 'quietUpdates': True}
    write_new(CONFIG, (json.dumps(config, indent=2) + '\n').encode(), 0o600, account.pw_uid, account.pw_gid)
    for name in verify_package(package):
        if name not in ('config.example.json', 'anchor-recall-companion.service'):
            write_new(APP / name, (package / name).read_bytes())
    unit = (package / 'anchor-recall-companion.service').read_text()
    expected = 'ExecStart=/usr/bin/node '
    if unit.count(expected) != 1:
        raise InstallerError('Unexpected companion service template.')
    write_new(SYSTEMD / SERVICE, unit.replace(expected, 'ExecStart=' + str(node) + ' ').encode())
    if bind_address is None:
        renewal = ('[Unit]\nDescription=Renew Anchor Recall IP certificate\n[Service]\nType=oneshot\n'
                   f'ExecStart={certbot} renew --cert-name {CERT_NAME} --quiet\n')
        write_new(SYSTEMD / (RENEW + '.service'), renewal.encode())
        timer = ('[Unit]\nDescription=Check Anchor Recall certificate twice daily\n[Timer]\n'
                 'OnCalendar=*-*-* 00,12:00:00\nRandomizedDelaySec=1800\nPersistent=true\n'
                 f'Unit={RENEW}.service\n[Install]\nWantedBy=timers.target\n')
        write_new(SYSTEMD / (RENEW + '.timer'), timer.encode())
    run(['runuser', '--user', USER, '--', node, APP / 'anchor-recall-companion.cjs', '--check', '--config', CONFIG], 30)
    units = [SYSTEMD / SERVICE]
    if bind_address is None:
        units.extend((SYSTEMD / (RENEW + '.service'), SYSTEMD / (RENEW + '.timer')))
    run(['systemd-analyze', 'verify', *units], 60)
    run(['systemctl', 'daemon-reload'], 60)
    if bind_address is None:
        run(['systemctl', 'enable', '--now', RENEW + '.timer'], 60)
    run(['systemctl', 'enable', '--now', SERVICE], 60)


def confirm_install():
    while True:
        answer = input('Введите INSTALL для установки или CANCEL для отмены: ').strip()
        start, end = '\x1b[200~', '\x1b[201~'
        if answer.startswith(start) and answer.endswith(end):
            answer = answer[len(start):-len(end)].strip()
        answer = answer.lower()
        if answer == 'install':
            return True
        if answer in ('', 'cancel', 'отмена', 'no', 'нет', 'n'):
            return False
        # A mistaken paste can contain a token; never echo the rejected input.
        print('Подтверждение не распознано. Введите INSTALL латинскими буквами или CANCEL.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', action='store_true', help='Print the installation plan without making changes or contacting services.')
    parser.add_argument('--existing-proxy', action='store_true', help='Install the backend only; keep your existing HTTPS proxy unchanged.')
    parser.add_argument('--bind-address', help='Explicit private IPv4 interface for --existing-proxy (port 8787).')
    args = parser.parse_args(argv)
    if args.existing_proxy != (args.bind_address is not None):
        parser.error('--existing-proxy requires --bind-address; use these options together.')
    try:
        bind_address = validate_private_ipv4(args.bind_address) if args.existing_proxy else None
        plan = BACKEND_PLAN if args.existing_proxy else PLAN
        if args.plan:
            print(plan)
            if bind_address is not None:
                print('Внутренний адрес для прокси: http://' + bind_address + ':8787')
            return 0
        package = Path(__file__).resolve().parent
        if bind_address is None:
            preflight(package)
        else:
            preflight(package, bind_address)
        if not sys.stdin.isatty() or not sys.stderr.isatty():
            raise InstallerError('An interactive terminal is required so the bot token cannot be echoed.')
        ip = bind_address
        if ip is None:
            ip = validate_ipv4(input('Публичный IPv4-адрес: ').strip())
            check_nginx(ip)
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            try:
                token = validate_bot_token(getpass.getpass('Ключ бота от BotFather (ввод скрыт): '))
            except getpass.GetPassWarning:
                raise InstallerError('Не удалось скрыть ввод. Запустите установщик в обычном терминале.') from None
        username = bot_username(token)
        print('\n' + plan + '\nБот: @' + username)
        if bind_address is None:
            print('Адрес: https://' + ip)
            print('Продолжая, вы соглашаетесь с условиями Let\'s Encrypt: https://letsencrypt.org/repository/')
        else:
            print('Внутренний адрес для прокси: http://' + bind_address + ':8787')
        if not confirm_install():
            print('Отменено. Установка ничего не меняла.')
            return 0
        if bind_address is None:
            install(package, ip, token, username)
            print('Готово. В Anchor Recall → Интеграции → Telegram введите https://' + ip +
                  ' и подключите бота. Оставляйте ноутбук включённым; ключ бота никому не передавайте.')
        else:
            install(package, ip, token, username, bind_address=bind_address)
            print('Backend установлен на http://' + bind_address + ':8787. '
                  'Настройте публичный HTTPS в существующем прокси перед подключением Obsidian. '
                  'Прокси, Docker и сертификаты установщик не менял.')
        return 0
    except (InstallerError, OSError, KeyboardInterrupt, EOFError) as error:
        message = str(error) if isinstance(error, InstallerError) else 'Installation stopped; existing files were preserved. See the manual guide before retrying.'
        print('Installation stopped: ' + message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
