"""Build a separate Android Balatro package from a local Steam copy and LMM base."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

from patch_mods import patch_mods


ANDROID = "http://schemas.android.com/apk/res/android"
OFFICIAL_PACKAGE = "com.playstack.balatro.android"
MOD_NAMES = ("smods", "balatrobot", "xk_game_bridge")
BASE_SOURCE = "https://lmm.shorty.systems/base.apk"


def sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def run(*command):
    command = [str(part) for part in command]
    print("+", subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, check=True)


def file_info(path):
    path = Path(path).resolve()
    return {"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size}


def change_manifest(path, package, label):
    ET.register_namespace("android", ANDROID)
    tree = ET.parse(path)
    root = tree.getroot()
    old_package = root.attrib["package"]
    root.set("package", package)
    application = root.find("application")
    application.set(f"{{{ANDROID}}}label", label)
    application.set(f"{{{ANDROID}}}debuggable", "true")
    for activity in application.findall("activity"):
        activity.set(f"{{{ANDROID}}}label", label)
    # AndroidX adds a package-specific permission; LMM exposes its own saves provider.
    for node in root.iter():
        if node.tag not in ("permission", "uses-permission", "provider"):
            continue
        for attribute in ("name", "authorities"):
            key = f"{{{ANDROID}}}{attribute}"
            value = node.get(key, "")
            if value.startswith(old_package + "."):
                node.set(key, package + value[len(old_package):])
    tree.write(path, encoding="utf-8", xml_declaration=True)
    return {
        "original_package": old_package,
        "package": package,
        "label": label,
        "debuggable": True,
        "base_version_name": root.get(f"{{{ANDROID}}}versionName"),
        "base_version_code": root.get(f"{{{ANDROID}}}versionCode"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base-apk", "java", "apktool", "signer", "game", "mods-dir", "work-dir", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--package", default="org.xiaoke.balatro.bridge")
    parser.add_argument("--label", default="小克牌局")
    args = parser.parse_args()
    if args.package == OFFICIAL_PACKAGE or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+", args.package):
        parser.error("Use a separate Android package; the official Balatro package must remain untouched.")
    for name in ("base_apk", "java", "apktool", "signer", "game", "mods_dir", "work_dir", "output"):
        setattr(args, name, getattr(args, name).resolve())
    args.work_dir.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="build-", dir=args.work_dir))
    apk_dir = stage / "apk"
    mods = stage / "Mods"
    framework = args.work_dir / "framework"
    print(f"Build directory: {stage}", flush=True)
    run(args.java, "-jar", args.apktool, "d", "-s", "-p", framework, "-o", apk_dir, args.base_apk)

    assets = apk_dir / "assets"
    assets.mkdir(exist_ok=True)
    with zipfile.ZipFile(args.game) as archive:
        if "main.lua" not in archive.namelist():
            raise ValueError("The supplied game ZIP must contain main.lua at its root.")
        archive.extractall(assets)
        game_files = len(archive.infolist())
    # Match the desktop language on first launch; saved user settings still win.
    globals_path = assets / "globals.lua"
    globals_text = globals_path.read_text(encoding="utf-8")
    if globals_text.count("language = 'en-us'") != 1:
        raise ValueError("Expected one default language setting in globals.lua")
    globals_path.write_text(globals_text.replace("language = 'en-us'", "language = 'zh_CN'", 1),
                            encoding="utf-8", newline="\n")

    for name in MOD_NAMES:
        shutil.copytree(args.mods_dir / name, mods / name,
                        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc"))
    patches = patch_mods(mods)
    manifest = change_manifest(apk_dir / "AndroidManifest.xml", args.package, args.label)
    unsigned = stage / "balatro-unsigned.apk"
    signed_dir = stage / "signed"
    run(args.java, "-jar", args.apktool, "b", "-p", framework, "-o", unsigned, apk_dir)
    run(args.java, "-jar", args.signer, "-a", unsigned, "--out", signed_dir)
    signed = list(signed_dir.glob("*-aligned-debugSigned.apk"))
    if len(signed) != 1:
        raise RuntimeError(f"Expected one signed APK in {signed_dir}, got {signed}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(signed[0], args.output)

    versions = {}
    for name in MOD_NAMES:
        for filename in ("manifest.json", name + ".json", "version.lua", "release.lua"):
            path = mods / name / filename
            if path.is_file():
                versions[f"{name}/{filename}"] = path.read_text(encoding="utf-8")
    mod_files = {str(p.relative_to(mods)).replace("\\", "/"): sha256(p)
                 for p in sorted(mods.rglob("*")) if p.is_file()}
    record = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        **manifest,
        "apk": file_info(args.output),
        "base_apk": {**file_info(args.base_apk), "source": BASE_SOURCE},
        "game": {**file_info(args.game), "files": game_files},
        "tools": {key: file_info(getattr(args, key)) for key in ("java", "apktool", "signer")},
        "mods_dir": str(mods),
        "mod_versions": versions,
        "mod_files": mod_files,
        "patches": patches,
        "default_language": "zh_CN",
        "work_dir": str(stage),
    }
    report = args.output.with_suffix(".build.json")
    report.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"apk": str(args.output), "sha256": record["apk"]["sha256"],
                      "mods": str(mods), "build_record": str(report)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
