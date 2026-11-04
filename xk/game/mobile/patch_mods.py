"""Apply phone settings to a staged copy of Mods before packaging or adb push."""

import argparse
import json
from pathlib import Path


MOBILE_SETTINGS = """-- XK mobile: app launches do not inherit balatrobot CLI environment variables.
BB_SETTINGS.host = "0.0.0.0"
BB_SETTINGS.port = 12346
BB_SETTINGS.gamespeed = 1
BB_SETTINGS.audio = true
-- XK mobile settings end
"""


def patch_mods(mods_dir: Path | str) -> dict:
    mods_dir = Path(mods_dir)
    bot = mods_dir / "balatrobot"
    main_path = bot / "balatrobot.lua"
    settings_path = bot / "src/lua/settings.lua"
    main = main_path.read_text(encoding="utf-8")
    settings = settings_path.read_text(encoding="utf-8")

    if MOBILE_SETTINGS not in main:
        marker = "BB_SETTINGS.setup()"
        if main.count(marker) != 1:
            raise ValueError(f"Expected one setup call in {main_path}")
        main = main.replace(marker, MOBILE_SETTINGS + marker, 1)

    tutorial_marker = "  G.F_SKIP_TUTORIAL = true\n"
    tutorial_call = "  G.FUNCS.tutorial_controller()"
    if tutorial_call not in settings:
        if settings.count(tutorial_marker) != 1:
            raise ValueError(f"Expected one tutorial setting in {settings_path}")
        settings = settings.replace(
            tutorial_marker,
            tutorial_marker + tutorial_call + " -- Initialize skipped tutorial before the first main menu.\n",
            1,
        )

    main_path.write_text(main, encoding="utf-8", newline="\n")
    settings_path.write_text(settings, encoding="utf-8", newline="\n")
    return {
        "mods_dir": str(mods_dir.resolve()),
        "files": [str(p.relative_to(mods_dir)) for p in (main_path, settings_path)],
        "settings": {"host": "0.0.0.0", "port": 12346, "gamespeed": 1, "audio": True},
        "tutorial_initialized": True,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mods_dir", type=Path, help="staged Mods folder containing balatrobot/")
    args = parser.parse_args()
    print(json.dumps(patch_mods(args.mods_dir), ensure_ascii=False, indent=2))
