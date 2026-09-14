"""Offline tests only: no real Render authentication, network or mutation."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('oda_release', Path(__file__).with_name('render-oda-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeRender:
    def __init__(self):
        self.calls, self.services, self.deploys = [], {}, {}
        self.fail_create = False

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if path.startswith('/services?'):
            return [{'service': item} for item in self.services.values()]
        if method == 'POST' and path == '/services':
            if self.fail_create:
                raise RuntimeError('Uncertain create response')
            identity = 'srv-' + body['name'].replace('-', '')
            url = 'oda-api-shard:10000' if body['type'] == 'private_service' else 'https://oda-web-test.onrender.com'
            service = {**body, 'id': identity, 'serviceDetails': {**body['serviceDetails'], 'url': url}}
            self.services[identity] = service
            return {'service': service, 'deployId': 'dep-initial' + identity}
        if method == 'GET' and path.count('/') == 2:
            return self.services[path.split('/')[2]]
        if '/env-vars/' in path or path.startswith('/env-groups/'):
            return {'ok': True}
        if path.endswith('/deploys') and method == 'POST':
            identity = 'dep-release' + path.split('/')[2]
            deploy = {'id': identity, 'status': 'build_in_progress', 'commit': {'id': body['commitId']}}
            self.deploys[identity] = deploy
            return deploy
        if '/deploys/' in path and method == 'GET':
            return self.deploys[path.split('/')[-1]]
        raise AssertionError(f'Unexpected offline request {method} {path}')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.args = argparse.Namespace(manifest=str(Path(__file__).resolve().parents[3] / 'render.oda.shared.yaml'),
            state_file=str(Path(self.temp.name) / 'state.json'), commit='a' * 40, owner='tea-test', env_group='evg-odatest',
            peer_roles='ofd_app', peer_web_origin='https://ofd-web.onrender.com')
        self.api = FakeRender()

    def tearDown(self):
        self.temp.cleanup()

    def test_create_configure_pinned_deploy_resume_preserves_secrets_and_sequencing(self):
        release = module.Release(self.args, self.api)
        created = release.create()
        creates = [body for method, path, body in self.api.calls if method == 'POST' and path == '/services']
        self.assertEqual([body['type'] for body in creates], ['private_service', 'web_service'])
        self.assertEqual(creates[0]['autoDeploy'], 'no')
        self.assertIn('preDeployCommand', creates[0]['serviceDetails'])
        self.assertNotIn('preDeployCommand', creates[0]['serviceDetails']['envSpecificDetails'])
        self.assertNotIn('healthCheckPath', creates[0]['serviceDetails'])
        self.assertEqual(creates[1]['serviceDetails']['healthCheckPath'], '/readyz')
        self.assertEqual(next(item['value'] for item in creates[1]['envVars'] if item['key'] == 'API_UPSTREAM_HOSTPORT'), 'oda-api-shard:4100')
        self.assertFalse(any(item['key'] in module.SECRET_NAMES for body in creates for item in body['envVars']))
        self.assertTrue(created['services']['api']['initialDeployId'])
        release.configure()
        link_calls = [(method, path) for method, path, body in self.api.calls if '/env-groups/' in path and '/services/' in path]
        self.assertEqual(link_calls, [('POST', '/env-groups/evg-odatest/services/srv-odaapi')])
        token_calls = [body for method, path, body in self.api.calls if path.endswith('/ODA_SETUP_TOKEN')]
        self.assertEqual(len(token_calls), 1)
        token = token_calls[0]['value']
        self.assertGreaterEqual(len(token), 43)
        self.assertNotIn(token, Path(self.args.state_file).read_text())
        self.assertNotIn('envVars', Path(self.args.state_file).read_text())
        before = len([item for item in self.api.calls if item[0] != 'GET'])
        resumed = module.Release(self.args, self.api)
        resumed.create(); resumed.configure()
        self.assertEqual(before, len([item for item in self.api.calls if item[0] != 'GET']))
        result = resumed.deploy()
        self.assertIn('releaseDeployId', result['services']['api'])
        self.assertNotIn('releaseDeployId', result['services']['web'])
        resumed.deploy()
        self.assertNotIn('releaseDeployId', resumed.state['services']['web'])
        self.api.deploys[result['services']['api']['releaseDeployId']]['status'] = 'live'
        resumed.deploy()
        self.assertIn('releaseDeployId', resumed.state['services']['web'])
        web_deploy = resumed.state['services']['web']['releaseDeployId']
        self.api.deploys[web_deploy]['status'] = 'live'
        self.assertTrue(resumed.status()['releaseLive'])

    def test_unknown_creation_result_blocks_duplicate_mutations(self):
        release = module.Release(self.args, self.api)
        self.api.fail_create = True
        with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
            release.create()
        with self.assertRaisesRegex(RuntimeError, 'Pending operation'):
            module.Release(self.args, self.api).create()
        self.assertEqual(len([item for item in self.api.calls if item[0] == 'POST']), 1)

    def test_existing_unrecorded_services_are_never_adopted(self):
        self.api.services['srv-existing'] = {'id': 'srv-existing', 'name': 'oda-api', 'ownerId': 'tea-test'}
        with self.assertRaisesRegex(RuntimeError, 'without a checkpoint'):
            module.Release(self.args, self.api).create()
        self.assertFalse(any(method != 'GET' for method, path, body in self.api.calls))

    def test_changed_release_and_wrong_live_commit_fail_closed(self):
        release = module.Release(self.args, self.api); release.create(); release.configure(); release.deploy()
        identity = release.state['services']['api']['releaseDeployId']
        self.api.deploys[identity].update(status='live', commit={'id': 'b' * 40})
        with self.assertRaisesRegex(RuntimeError, 'wrong commit'):
            release.status()
        self.args.commit = 'b' * 40
        with self.assertRaisesRegex(RuntimeError, 'Checkpoint does not match'):
            module.Release(self.args, self.api)


if __name__ == '__main__':
    unittest.main()
