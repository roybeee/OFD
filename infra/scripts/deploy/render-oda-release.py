#!/usr/bin/env python3
"""ODA-only Render operator: create, configure, deploy and inspect, with secret-free checkpoints.

Requires PyYAML. No secret is accepted on the command line. Authentication is read
from a mode-0600 Render CLI YAML file (api.key) or a plain API-key file. Setup keys
are generated in memory and written only to the specified ODA environment group.
Creating a service can start its initial deployment despite autoDeploy='no'.
Only deploy/status verify the separately triggered, pinned release deployment.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

import yaml

REPO = 'https://github.com/roybeee/OFD'
API_BASE = 'https://api.render.com/v1'
SECRET_NAMES = {'DATABASE_URL', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'ODA_SETUP_TOKEN', 'ODA_SETUP_EXPIRES_AT'}
FAILED = {'build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('Render API redirect refused; no credentials forwarded')


class Render:
    def __init__(self, auth_file):
        path = Path(auth_file)
        require(path.is_file() and not path.is_symlink(), 'Authentication file must be a regular file')
        require(path.stat().st_mode & 0o077 == 0, 'Authentication file permissions must exclude group/other access')
        try:
            value = yaml.safe_load(path.read_text())
            key = value.get('api', {}).get('key') if isinstance(value, dict) else value
            require(isinstance(key, str) and key.strip(), 'Render authentication key missing')
        except Exception:
            raise RuntimeError('Unable to read Render authentication file') from None
        self.key = key.strip()
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None):
        require(path.startswith('/') and not path.startswith('//'), 'Invalid Render API path')
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API_BASE + path, data=data, method=method,
            headers={'Authorization': 'Bearer ' + self.key, 'Accept': 'application/json', 'Content-Type': 'application/json'})
        try:
            with self.opener.open(req, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw.strip() else None
        except urllib.error.HTTPError as exc:
            # Response bodies from secret-setting endpoints can echo credentials.
            raise RuntimeError(f'Render {method} {path} returned HTTP {exc.code}; response omitted') from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            raise RuntimeError(f'Render {method} {path} did not return a usable response; inspect pending checkpoint before retry') from None


def save(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, tmp = tempfile.mkstemp(prefix='.oda-release-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_manifest(path):
    content = Path(path).read_bytes()
    value = yaml.safe_load(content)
    require(isinstance(value, dict) and set(value) == {'services'}, 'Manifest must contain only the two ODA services')
    definitions = value['services']
    require(len(definitions) == 2, 'Exactly oda-api and oda-web are required')
    services = {item['name']: item for item in definitions}
    require(set(services) == {'oda-api', 'oda-web'}, 'Refusing non-ODA service names')
    require(services['oda-api']['type'] == 'pserv' and services['oda-web']['type'] == 'web', 'ODA service types mismatch')
    for item in services.values():
        require(item['runtime'] == 'docker' and item['region'] == 'singapore', 'Expected Docker in Singapore')
        require(item.get('autoDeployTrigger') == 'off', 'Automatic deployments must be off')
        require(not any(env.get('key') in SECRET_NAMES and 'value' in env for env in item['envVars']), 'Secrets must not be embedded in the manifest')
    return services, hashlib.sha256(content).hexdigest()


def service_payload(definition, owner, commit, overrides):
    variables = []
    for entry in definition['envVars']:
        key = entry['key']
        if key in SECRET_NAMES:
            continue
        if key in overrides:
            value = overrides[key]
        elif 'value' in entry:
            value = str(entry['value'])
        elif key == 'RELEASE_SHA':
            value = commit
        elif key in {'PUBLIC_APP_URL', 'WEB_ORIGIN'}:
            continue  # Set from the actual returned web-service URL during configure.
        else:
            raise RuntimeError(f'Unresolved nonsecret manifest field: {key}')
        variables.append({'key': key, 'value': value})
    details = {'runtime': 'docker', 'plan': definition['plan'], 'region': definition['region'], 'numInstances': 1,
        'maxShutdownDelaySeconds': definition.get('maxShutdownDelaySeconds', 30),
        'envSpecificDetails': {key: definition[key] for key in ('dockerfilePath', 'dockerContext', 'dockerCommand')}}
    for key in ('preDeployCommand', 'healthCheckPath'):
        if key in definition:
            require(key != 'healthCheckPath' or definition['type'] == 'web', 'Private service cannot set healthCheckPath')
            details[key] = definition[key]
    return {'type': 'private_service' if definition['type'] == 'pserv' else 'web_service', 'name': definition['name'],
        'ownerId': owner, 'repo': REPO, 'branch': definition['branch'], 'autoDeploy': 'no', 'envVars': variables,
        'serviceDetails': details}


def service_from(value):
    return value.get('service', value) if isinstance(value, dict) else {}


def check_service(service, definition, owner):
    require(service.get('ownerId') == owner and service.get('name') == definition['name'], 'Service identity/owner mismatch')
    require(service.get('repo', '').removesuffix('.git') == REPO and service.get('branch') == definition['branch'], 'Service source mismatch')
    require(service.get('type') == ('private_service' if definition['type'] == 'pserv' else 'web_service'), 'Service type mismatch')
    details = service.get('serviceDetails', {})
    require(details.get('runtime', details.get('env')) == 'docker' and details.get('region') == definition['region'], 'Service runtime/region mismatch')
    require(service.get('autoDeploy') == 'no', 'Service automatic deployments are unexpectedly enabled')
    return service


def metadata(service, response=None):
    identity = service.get('id', '')
    require(re.fullmatch(r'srv-[a-z0-9]+', identity), 'Render service ID missing')
    details = service.get('serviceDetails', {})
    result = {'id': identity, 'name': service['name'], 'url': details.get('url', '')}
    if isinstance(response, dict) and response.get('deployId'):
        result['initialDeployId'] = response['deployId']
    return result


def internal_hostport(url):
    parsed = urllib.parse.urlsplit(url if '://' in url else '//' + url)
    host = parsed.hostname or ''
    require(bool(re.fullmatch(r'[a-z0-9][a-z0-9.-]*', host)) and not parsed.username and not parsed.password,
        'Render did not return a valid private service DNS name')
    # The application listens on the manifest's API_PORT, not the default port in Render's URL.
    return host + ':4100'


def web_origin(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
        and not parsed.query and not parsed.fragment and parsed.path in ('', '/'), 'Render web URL must be an HTTPS origin')
    return 'https://' + parsed.netloc


class Release:
    def __init__(self, args, api):
        self.args, self.api = args, api
        self.definitions, manifest_hash = read_manifest(args.manifest)
        require(re.fullmatch(r'[a-f0-9]{40}', args.commit), 'A full lowercase release commit SHA is required')
        require(re.fullmatch(r'tea-[a-z0-9]+', args.owner), 'A workspace owner ID is required')
        require(re.fullmatch(r'evg-[a-z0-9]+', args.env_group), 'An ODA environment group ID is required')
        require(re.fullmatch(r'[a-z_][a-z0-9_]*(?:,[a-z_][a-z0-9_]*)*', args.peer_roles), 'Explicit comma-separated OFD runtime roles required')
        require(web_origin(args.peer_web_origin) == args.peer_web_origin, 'Exact OFD HTTPS origin required')
        spec = {'manifestSha256': manifest_hash, 'commit': args.commit, 'ownerId': args.owner, 'envGroupId': args.env_group,
            'peerRoles': args.peer_roles, 'peerWebOrigin': args.peer_web_origin}
        path = Path(args.state_file)
        require(not path.is_symlink(), 'Checkpoint must not be a symlink')
        self.state = json.loads(path.read_text()) if path.exists() else {'version': 1, 'spec': spec, 'services': {}, 'configured': []}
        require(self.state.get('version') == 1 and self.state.get('spec') == spec, 'Checkpoint does not match this release/configuration')

    def persist(self):
        save(self.args.state_file, self.state)

    def current(self, label):
        item = self.state['services'][label]
        service = service_from(self.api.request('GET', '/services/' + item['id']))
        check_service(service, self.definitions['oda-' + label], self.args.owner)
        item.update(metadata(service))
        return item

    def create(self):
        require(not self.state.get('pending'), 'Pending operation exists; reconcile it before any new mutation')
        # Do not adopt or modify an existing service not recorded by this operator.
        cursor = ''
        existing = []
        while True:
            query = urllib.parse.urlencode({'ownerId': self.args.owner, 'limit': 100, **({'cursor': cursor} if cursor else {})})
            rows = self.api.request('GET', '/services?' + query)
            require(isinstance(rows, list), 'Invalid Render service list')
            existing.extend(service_from(row) for row in rows)
            if len(rows) < 100:
                break
            next_cursor = rows[-1].get('cursor', '')
            require(next_cursor and next_cursor != cursor, 'Render service pagination did not advance')
            cursor = next_cursor
        for label in ('api', 'web'):
            if label in self.state['services']:
                self.current(label)
                continue
            definition = self.definitions['oda-' + label]
            require(not any(item.get('name') == definition['name'] and item.get('ownerId') == self.args.owner for item in existing),
                f'{definition["name"]} already exists without a checkpoint; refusing to adopt or overwrite it')
            overrides = {'ODA_PEER_DB_ROLES': self.args.peer_roles, 'ODA_PEER_WEB_ORIGIN': self.args.peer_web_origin}
            if label == 'web':
                overrides['API_UPSTREAM_HOSTPORT'] = internal_hostport(self.current('api')['url'])
            body = service_payload(definition, self.args.owner, self.args.commit, overrides)
            self.state['pending'] = {'operation': 'create', 'label': label, 'startedAt': now()}; self.persist()
            response = self.api.request('POST', '/services', body)
            service = service_from(response)
            check_service(service, definition, self.args.owner)
            self.state['services'][label] = metadata(service, response)
            self.state.pop('pending'); self.persist()
        return self.summary()

    def configure(self):
        require(not self.state.get('pending'), 'Pending operation exists; reconcile it before any new mutation')
        require(set(self.state['services']) == {'api', 'web'}, 'Create both services first')
        api, web = self.current('api'), self.current('web')
        origin = web_origin(web['url'])
        require(origin != self.args.peer_web_origin, 'ODA and OFD origins must differ')
        operations = [
            ('web-upstream', 'PUT', f'/services/{web["id"]}/env-vars/API_UPSTREAM_HOSTPORT', {'value': internal_hostport(api['url'])}),
            ('api-web-origin', 'PUT', f'/services/{api["id"]}/env-vars/WEB_ORIGIN', {'value': origin}),
            ('api-public-url', 'PUT', f'/services/{api["id"]}/env-vars/PUBLIC_APP_URL', {'value': origin}),
            ('api-secret-group', 'POST', f'/env-groups/{self.args.env_group}/services/{api["id"]}', None),
        ]
        for name, method, path, body in operations:
            if name in self.state['configured']:
                continue
            self.api.request(method, path, body)
            self.state['configured'].append(name); self.persist()
        if 'setup-key' not in self.state['configured']:
            # Expiry first; if the token write's response is lost, do not silently replace a potentially used token.
            expires = (datetime.now(timezone.utc) + timedelta(hours=48)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            self.api.request('PUT', f'/env-groups/{self.args.env_group}/env-vars/ODA_SETUP_EXPIRES_AT', {'value': expires})
            self.state['pending'] = {'operation': 'setup-key', 'startedAt': now(), 'expiresAt': expires}; self.persist()
            token = secrets.token_urlsafe(32)
            self.api.request('PUT', f'/env-groups/{self.args.env_group}/env-vars/ODA_SETUP_TOKEN', {'value': token})
            del token
            self.state['setupExpiresAt'] = expires
            self.state['configured'].append('setup-key'); self.state.pop('pending'); self.persist()
        return self.summary()

    def deploy(self):
        require(not self.state.get('pending'), 'Pending operation exists; inspect status and reconcile before another deploy')
        require(set(self.state['configured']) == {'web-upstream', 'api-web-origin', 'api-public-url', 'api-secret-group', 'setup-key'}, 'Configure first')
        for label in ('api', 'web'):
            item = self.current(label)
            if item.get('releaseDeployId'):
                deploy = self.read_deploy(label)
                require(deploy['status'] not in FAILED, f'ODA {label} release failed; inspect logs before choosing a new deployment')
                if deploy['status'] != 'live':
                    return self.summary()
                continue
            self.state['pending'] = {'operation': 'deploy', 'label': label, 'startedAt': now()}; self.persist()
            response = self.api.request('POST', f'/services/{item["id"]}/deploys', {'commitId': self.args.commit, 'clearCache': 'do_not_clear'})
            deploy = response.get('deploy', response) if isinstance(response, dict) else {}
            if not deploy.get('id'):
                return self.summary()  # A 202 may be queued; status discovers the queued deployment.
            item['releaseDeployId'] = deploy['id']; item['releaseStatus'] = deploy.get('status', 'created')
            self.state.pop('pending'); self.persist()
            return self.summary()  # The next deploy call waits for API live before starting web.
        return self.summary()

    def read_deploy(self, label):
        item = self.state['services'][label]
        result = self.api.request('GET', f'/services/{item["id"]}/deploys/{item["releaseDeployId"]}')
        deploy = result.get('deploy', result)
        require(deploy.get('id') == item['releaseDeployId'], 'Release deployment identity mismatch')
        if deploy.get('status') == 'live':
            require(deploy.get('commit', {}).get('id') == self.args.commit, 'Live deployment has the wrong commit SHA')
        item['releaseStatus'] = deploy.get('status', 'unknown'); self.persist()
        return deploy

    def status(self):
        pending = self.state.get('pending', {})
        if pending.get('operation') == 'deploy':
            label = pending['label']; item = self.state['services'][label]
            rows = self.api.request('GET', f'/services/{item["id"]}/deploys?limit=100')
            matches = [row.get('deploy', row) for row in rows]
            matches = [row for row in matches if row.get('commit', {}).get('id') == self.args.commit
                and row.get('id') != item.get('initialDeployId') and row.get('createdAt', '') >= pending['startedAt']]
            require(len(matches) <= 1, 'Several deployments match pending trigger; reconcile explicitly')
            if matches:
                item['releaseDeployId'] = matches[0]['id']; self.state.pop('pending'); self.persist()
        for label in self.state['services']:
            self.current(label)
            if self.state['services'][label].get('releaseDeployId'):
                self.read_deploy(label)
        self.persist()
        return self.summary()

    def summary(self):
        return {'services': self.state['services'], 'configured': self.state['configured'],
            'setupExpiresAt': self.state.get('setupExpiresAt'), 'pending': self.state.get('pending'),
            'releaseLive': set(self.state['services']) == {'api', 'web'} and all(
                item.get('releaseStatus') == 'live' for item in self.state['services'].values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['create', 'configure', 'deploy', 'status'])
    parser.add_argument('--auth-file', required=True)
    parser.add_argument('--state-file', required=True)
    parser.add_argument('--manifest', default='render.oda.shared.yaml')
    parser.add_argument('--owner', required=True)
    parser.add_argument('--env-group', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--peer-roles', required=True)
    parser.add_argument('--peer-web-origin', required=True)
    args = parser.parse_args()
    try:
        lock_path = Path(args.state_file + '.lock')
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as lock:
            os.fchmod(lock.fileno(), 0o600)
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('Another ODA release operator is using this checkpoint') from None
            release = Release(args, Render(args.auth_file))
            print(json.dumps(getattr(release, args.command)(), ensure_ascii=False, indent=2))
    except Exception as exc:
        # Do not emit tracebacks, response bodies, secret payloads or credential-bearing URLs.
        message = str(exc) if isinstance(exc, RuntimeError) else 'ODA release operation failed; details omitted to protect credentials'
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
