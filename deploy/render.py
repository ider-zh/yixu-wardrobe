"""Render reviewed deployment templates; secrets remain outside the release."""
import argparse
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("output", "web-root", "backend-root", "data-root", "runtime-env"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--api-port", type=int, default=8765)
    args = parser.parse_args()
    if not 1 <= args.api_port <= 65535:
        parser.error("invalid application port")
    values = {"API_PORT": str(args.api_port)}
    for name in ("web_root", "backend_root", "data_root", "runtime_env"):
        value = str(getattr(args, name))
        if not Path(value).is_absolute() or any(c.isspace() or c in ";{}\"" for c in value):
            parser.error("deployment paths must be absolute and contain no config syntax")
        values[name.upper()] = value
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    for name in ("site.conf", "admin.conf", "yixu-api.service", "yixu-worker.service", "yixu-egress.service"):
        text = (source / name).read_text()
        for key, value in values.items():
            text = text.replace("@@" + key + "@@", value)
        if "@@" in text:
            raise ValueError("unresolved template marker")
        (output / name).write_text(text)
    print("Deployment files rendered; run nginx -t and systemd-analyze verify before installing.")


if __name__ == "__main__":
    main()
