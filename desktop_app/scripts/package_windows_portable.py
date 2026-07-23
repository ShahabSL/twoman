#!/usr/bin/env python3
"""Assemble a portable Windows desktop bundle.

This script copies a built Windows Tauri executable plus bundled sidecars into
the repo's private handoff folder and writes the portable-mode markers that the
app requires to keep state beside the executable.
"""

from __future__ import annotations

import json
import os
import shutil
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
APP_ROOT = REPO_ROOT / "desktop_app"
TAURI_CONFIG_PATH = APP_ROOT / "src-tauri/tauri.conf.json"
WINDOWS_BUILD_ROOT = Path(
    os.environ.get(
        "TWOMAN_WINDOWS_BUILD_ROOT",
        APP_ROOT / "src-tauri/target/release",
    )
)
WINDOWS_BUNDLE_ROOT = WINDOWS_BUILD_ROOT / "bundle"
PORTABLE_ONLY = os.environ.get("TWOMAN_PORTABLE_ONLY", "").strip().lower() in {
    "1",
    "true",
    "yes",
}
WINDOWS_SIDECAR_CANDIDATES = [
    APP_ROOT / "build/windows-sidecars/dist",
    REPO_ROOT / "desktop_app/src-tauri/resources/sidecars/windows",
]
HANDOFF_ROOT = REPO_ROOT / "private_handoff/desktop_app/windows"


def load_app_version() -> str:
    config = json.loads(TAURI_CONFIG_PATH.read_text(encoding="utf-8"))
    version = str(config.get("version", "")).strip()
    if not version:
        raise ValueError(f"missing version in {TAURI_CONFIG_PATH}")
    return version


APP_VERSION = load_app_version()


def load_app_display_name() -> str:
    configured = os.environ.get("TWOMAN_DESKTOP_DISPLAY_NAME", "").strip()
    if configured:
        return configured
    config = json.loads(TAURI_CONFIG_PATH.read_text(encoding="utf-8"))
    return str(config.get("productName", "")).strip() or "Twoman"


APP_DISPLAY_NAME = load_app_display_name()
APP_SLUG = APP_DISPLAY_NAME.replace(" ", "_")
PORTABLE_ROOT = HANDOFF_ROOT / f"portable-ui/{APP_DISPLAY_NAME}"
PORTABLE_DATA_ROOT = PORTABLE_ROOT / "portable-data"
SIDECAR_ROOT = PORTABLE_ROOT / "sidecars/windows"
HELPER_NAME = os.environ.get("TWOMAN_HELPER_BINARY_BASENAME", "twoman-helper").strip() or "twoman-helper"
GATEWAY_NAME = os.environ.get("TWOMAN_GATEWAY_BINARY_BASENAME", "twoman-gateway").strip() or "twoman-gateway"
TUNNEL_NAME = os.environ.get("TWOMAN_TUNNEL_BINARY_BASENAME", "twoman-tunnel").strip() or "twoman-tunnel"


def windows_artifact_name(suffix: str) -> str:
    return f"{APP_SLUG}_{APP_VERSION}_x64{suffix}"


def windows_bundle_candidates(suffix: str) -> list[Path]:
    names = [
        f"{APP_DISPLAY_NAME}_{APP_VERSION}_x64{suffix}",
        f"{APP_SLUG}_{APP_VERSION}_x64{suffix}",
    ]
    bundle_dir = "nsis" if suffix.endswith(".exe") else "msi"
    return [WINDOWS_BUNDLE_ROOT / bundle_dir / name for name in names]


def resolve_windows_bundle(suffix: str) -> Path:
    for candidate in windows_bundle_candidates(suffix):
        if candidate.exists():
            return candidate
    searched = "\n".join(str(path) for path in windows_bundle_candidates(suffix))
    raise FileNotFoundError(f"missing required artifact; searched:\n{searched}")


def copy_required_file(source: Path, destination: Path) -> None:
    if not source.exists():
        raise FileNotFoundError(f"missing required artifact: {source}")
    if source.resolve() == destination.resolve():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def resolve_sidecar(name: str) -> Path:
    for root in WINDOWS_SIDECAR_CANDIDATES:
        candidate = root / name
        if candidate.exists():
            return candidate
    searched = "\n".join(str(path) for path in WINDOWS_SIDECAR_CANDIDATES)
    raise FileNotFoundError(f"missing sidecar {name}; searched:\n{searched}")


def write_portable_markers() -> None:
    PORTABLE_DATA_ROOT.mkdir(parents=True, exist_ok=True)
    (PORTABLE_ROOT / "twoman-portable").write_text(
        f"Portable mode marker for {APP_DISPLAY_NAME}.\n",
        encoding="utf-8",
    )
    (PORTABLE_DATA_ROOT / "README.txt").write_text(
        (
            f"{APP_DISPLAY_NAME} portable runtime data lives here.\n"
            "- config/: saved routes, shares, and settings\n"
            "- runtime/: generated helper/share configs\n"
            "- twoman-logs/: helper, tunnel, and shared proxy logs\n"
        ),
        encoding="utf-8",
    )


def build_zip() -> Path:
    zip_path = HANDOFF_ROOT / windows_artifact_name("-portable.zip")
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(PORTABLE_ROOT.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(HANDOFF_ROOT / "portable-ui"))
    return zip_path


def main() -> None:
    HANDOFF_ROOT.mkdir(parents=True, exist_ok=True)
    if PORTABLE_ROOT.exists():
        shutil.rmtree(PORTABLE_ROOT)
    copy_required_file(
        WINDOWS_BUILD_ROOT / "desktop_app.exe",
        PORTABLE_ROOT / f"{APP_DISPLAY_NAME}.exe",
    )
    webview_loader = WINDOWS_BUILD_ROOT / "WebView2Loader.dll"
    if webview_loader.exists():
        copy_required_file(webview_loader, PORTABLE_ROOT / webview_loader.name)
    if not PORTABLE_ONLY:
        copy_required_file(
            resolve_windows_bundle("-setup.exe"),
            HANDOFF_ROOT / windows_artifact_name("-setup.exe"),
        )
        copy_required_file(
            resolve_windows_bundle("_en-US.msi"),
            HANDOFF_ROOT / windows_artifact_name("_en-US.msi"),
        )
    copy_required_file(
        resolve_sidecar(f"{HELPER_NAME}.exe"),
        SIDECAR_ROOT / f"{HELPER_NAME}.exe",
    )
    copy_required_file(
        resolve_sidecar(f"{GATEWAY_NAME}.exe"),
        SIDECAR_ROOT / f"{GATEWAY_NAME}.exe",
    )
    copy_required_file(
        resolve_sidecar(f"{TUNNEL_NAME}.exe"),
        SIDECAR_ROOT / f"{TUNNEL_NAME}.exe",
    )
    write_portable_markers()
    zip_path = build_zip()
    print(f"portable zip ready: {zip_path}")


if __name__ == "__main__":
    main()
