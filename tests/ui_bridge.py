"""Disposable JSON-line DOM/ASGI test bridge; never reads operator configuration.

The caller supplies an empty temporary directory. No worker, provider configuration,
provider replacement or network listener is started. Credentials stay in that private
fixture directory/pipe and must not be included in regression output.
"""

import json
import secrets
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings
from backend.store import digest


def main():
    root = Path(sys.argv[1])
    if not root.is_dir() or any(root.iterdir()):
        raise ValueError("UI bridge requires an empty disposable directory")
    app = create_app(Settings(data_dir=root))
    with TestClient(app, base_url="https://localhost") as client:
        for line in sys.stdin:
            data = json.loads(line)
            control = data.get("control")
            if control == "clear_cookie":
                client.cookies.clear()
                result = {"ok": True}
            elif control == "revoke_admin":
                with app.state.store.connect() as db:
                    db.execute("DELETE FROM admin_sessions")
                result = {"ok": True}
            elif control in ("rotate_csrf", "seed_history"):
                token = client.cookies.get("yixu_visitor") or ""
                with app.state.store.connect() as db:
                    owner = db.execute(
                        "SELECT id FROM visitors WHERE token_hash=?", (digest(token),)
                    ).fetchone()[0]
                    if control == "rotate_csrf":
                        db.execute(
                            "UPDATE visitors SET csrf=? WHERE id=?",
                            (secrets.token_urlsafe(32), owner),
                        )
                    else:
                        # Synthetic canceled history only; no input/output image or fake success.
                        db.execute(
                            "INSERT INTO jobs (id,owner,idempotency_key,fingerprint,status,"
                            "look_id,edition,shot_index,created,expires) "
                            "VALUES ('ui-canceled',?,'ui-only','ui-only','canceled',1,'v1',1,0,0)",
                            (owner,),
                        )
                result = {"ok": True}
            elif control:
                raise ValueError("Unknown bridge control")
            else:
                response = client.request(
                    data.get("method", "GET"), data["path"],
                    headers=data.get("headers", {}), json=data.get("body"),
                )
                result = {"status": response.status_code, "body": response.json()}
            print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
