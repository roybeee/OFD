"""Explicit operator workflow for OFD/ODA account separation on Render.

Secrets stay in process memory and Render's secret environment storage. The
checkpoint contains resource IDs and operation status only. This tool does not
read whole service environments or automatically retry failed mutations.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import shlex
import urllib.error
import urllib.parse
import urllib.request
import yaml

OWNER = "tea-d964200js32c738tskk0"
API = "srv-d9ojh7j7uimc739igii0"
WORKER = "srv-d9pi0al3erlc73967mk0"
PG = "dpg-d9otud4s728c73ftl2ig-a"
TEMP_KEYS = ["ODA_PROVISION_OFD_PASSWORD", "ODA_PROVISION_ODA_PASSWORD", "ODA_PROVISION_APPLY"]


class OperationError(Exception):
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["prepare", "provision", "job-status", "cleanup-temporary", "cutover-api", "cutover-worker", "rollback-api", "rollback-worker"])
    parser.add_argument("--auth-config", required=True)
    parser.add_argument("--checkpoint", required=True)
    args = parser.parse_args()
    key = yaml.safe_load(Path(args.auth_config).read_text())["api"]["key"]
    checkpoint = Path(args.checkpoint)
    state = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}

    def save():
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        temporary = checkpoint.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(state, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, checkpoint)

    def call(path, method="GET", body=None, absent_ok=False):
        request = urllib.request.Request(
            "https://api.render.com/v1" + path,
            data=None if body is None else json.dumps(body).encode(),
            method=method,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            if absent_ok and error.code == 404:
                return None
            # Never print response bodies: an API may echo submitted secrets.
            raise OperationError(f"RENDER_HTTP_{error.code} {method} {path}") from None
        except Exception:
            raise OperationError(f"RENDER_NETWORK_FAILED {method} {path}") from None

    def env_value(service, name, absent_ok=False):
        result = call(f"/services/{service}/env-vars/{name}", absent_ok=absent_ok)
        return None if result is None else result.get("value", result.get("envVar", {}).get("value"))

    def group_value(group_key):
        result = call(f"/env-groups/{state['groups'][group_key]}/env-vars/DATABASE_URL")
        value = result.get("value", result.get("envVar", {}).get("value"))
        if not value:
            raise OperationError("GROUP_DATABASE_URL_MISSING")
        return value

    def set_env(service, name, value):
        call(f"/services/{service}/env-vars/{name}", "PUT", {"value": value})

    def create_group(group_key, name, values):
        result = call("/env-groups", "POST", {"name": name, "ownerId": OWNER,
            "envVars": [{"key": name, "value": value} for name, value in values.items()]})
        group = result.get("envGroup", result)
        if not group.get("id"):
            raise OperationError("GROUP_ID_MISSING")
        state["groups"][group_key] = group["id"]
        save()

    if args.action == "prepare":
        if state:
            raise OperationError("CHECKPOINT_EXISTS_REVIEW_BEFORE_ANY_RETRY")
        old_api = env_value(API, "DATABASE_URL")
        old_worker = env_value(WORKER, "DATABASE_URL")
        if not old_api or old_api != old_worker:
            raise OperationError("OFD_CONNECTIONS_REQUIRE_INDIVIDUAL_REVIEW")
        url = urllib.parse.urlsplit(old_api)
        if url.scheme not in ("postgres", "postgresql") or urllib.parse.unquote(url.username or "") != "ofd_postgres_user" or url.path != "/ofd_postgres" or not url.password or url.fragment:
            raise OperationError("EXISTING_OFD_DATABASE_IDENTITY_MISMATCH")
        if url.hostname != PG and not (url.hostname or "").startswith(PG + "."):
            raise OperationError("EXISTING_OFD_HOST_MISMATCH")
        if any(k != "sslmode" or v != "require" for k, v in urllib.parse.parse_qsl(url.query)):
            raise OperationError("CONNECTION_QUERY_REQUIRES_REVIEW")
        for name in TEMP_KEYS:
            if env_value(WORKER, name, absent_ok=True) is not None:
                raise OperationError("TEMPORARY_PROVISIONING_VARIABLE_ALREADY_EXISTS")
        passwords = {brand: secrets.token_urlsafe(36) + "aA1!" for brand in ("ofd", "oda")}
        def replacement(brand, database):
            host = url.hostname + (":" + str(url.port) if url.port else "")
            netloc = brand + "_app:" + urllib.parse.quote(passwords[brand], safe="") + "@" + host
            return urllib.parse.urlunsplit((url.scheme, netloc, "/" + database, url.query, ""))
        state.update({"ownerId": OWNER, "postgresId": PG, "groups": {}, "stage": "preparing"})
        save()
        create_group("rollback", "ofd-account-separation-rollback", {"DATABASE_URL": old_api})
        create_group("ofd", "ofd-runtime-database", {"DATABASE_URL": replacement("ofd", "ofd_postgres")})
        create_group("oda", "oda-production-secrets", {
            "DATABASE_URL": replacement("oda", "oda_production"),
            "SESSION_SECRET": secrets.token_urlsafe(48),
            "ENCRYPTION_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
        })
        set_env(WORKER, TEMP_KEYS[0], passwords["ofd"])
        set_env(WORKER, TEMP_KEYS[1], passwords["oda"])
        set_env(WORKER, TEMP_KEYS[2], "1")
        state["stage"] = "credentials_prepared_no_database_mutation"
        save()
        print(json.dumps({"stage": state["stage"], "groups": state["groups"]}))
    elif args.action == "provision":
        if state.get("stage") != "credentials_prepared_no_database_mutation" or state.get("provisionJob"):
            raise OperationError("PROVISION_STAGE_MISMATCH")
        script = Path(__file__).with_name("oda-shared-provision.mjs").read_text()
        script += "\nawait provisionSharedDatabase().catch(() => { process.exitCode = 1; });\n"
        result = call(f"/services/{WORKER}/jobs", "POST", {
            "startCommand": "node --input-type=module -e " + shlex.quote(script), "planId": "plan-srv-006"})
        state["provisionJob"] = result["id"]
        state["stage"] = "provision_job_started"
        save()
        print(json.dumps({"jobId": result["id"], "status": result.get("status")}))
    elif args.action == "job-status":
        result = call(f"/services/{WORKER}/jobs/{state['provisionJob']}")
        if result.get("status") == "succeeded":
            state["stage"] = "database_provisioning_verified"
            save()
        print(json.dumps({k: result.get(k) for k in ("id", "status", "finishedAt")}))
    elif args.action == "cleanup-temporary":
        result = call(f"/services/{WORKER}/jobs/{state['provisionJob']}")
        if not result.get("finishedAt"):
            raise OperationError("PROVISION_JOB_STILL_RUNNING")
        for name in TEMP_KEYS:
            call(f"/services/{WORKER}/env-vars/{name}", "DELETE", absent_ok=True)
        state["temporaryVariablesRemoved"] = True
        save()
        print(json.dumps({"temporaryVariablesRemoved": True}))
    else:
        service = API if args.action.endswith("api") else WORKER
        target = "api" if service == API else "worker"
        reverting = args.action.startswith("rollback")
        if not reverting and state.get("stage") != "database_provisioning_verified":
            raise OperationError("DATABASE_PROVISIONING_NOT_VERIFIED")
        if not reverting and target == "worker":
            api_deploy = state.get("deploys", {}).get("api")
            if not api_deploy or call(f"/services/{API}/deploys/{api_deploy}").get("status") != "live":
                raise OperationError("API_CUTOVER_MUST_BE_LIVE_FIRST")
        value = group_value("rollback" if reverting else "ofd")
        set_env(service, "DATABASE_URL", value)
        result = call(f"/services/{service}/deploys", "POST", {})
        state.setdefault("deploys", {})[("rollback_" if reverting else "") + target] = result["id"]
        save()
        print(json.dumps({"serviceId": service, "deployId": result["id"], "status": result.get("status"), "rollback": reverting}))


if __name__ == "__main__":
    try:
        main()
    except OperationError as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({"error": "UNEXPECTED_OPERATION_FAILURE_REVIEW_CHECKPOINT"}))
        raise SystemExit(1)
