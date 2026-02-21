#!/usr/bin/env python3
"""Generate RuneScape Arena art assets using the openai-image-gen skill script.

Requires:
  - OPENAI_API_KEY set in the environment
  - /Users/home/.codex/skills/openai-image-gen/scripts/gen.py available
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SKILL_SCRIPT = Path("/Users/home/.codex/skills/openai-image-gen/scripts/gen.py")
DEFAULT_PROMPTS = Path("assets/prompts/openai-f2p-assets.json")
DEFAULT_OUT_DIR = Path("public/assets/generated")


def find_generated_image(folder: Path) -> Path | None:
    for ext in ("*.png", "*.webp", "*.jpeg", "*.jpg"):
        matches = sorted(folder.glob(ext))
        if matches:
            return matches[0]
    return None


def run_one(prompt_def: dict, out_dir: Path, dry_run: bool, skip_existing: bool) -> dict:
    asset_id = prompt_def["id"]
    target_path = out_dir / f"{asset_id}.png"

    if dry_run:
        return {
            "id": asset_id,
            "kind": prompt_def.get("kind", "unknown"),
            "path": f"/assets/generated/{target_path.name}",
            "source_prompt": prompt_def["prompt"],
            "model": prompt_def.get("model", "gpt-image-1"),
            "generated": False,
        }

    if skip_existing and target_path.exists():
        return {
            "id": asset_id,
            "kind": prompt_def.get("kind", "unknown"),
            "path": f"/assets/generated/{target_path.name}",
            "source_prompt": prompt_def["prompt"],
            "model": prompt_def.get("model", "gpt-image-1"),
            "generated": True,
            "reused": True,
        }

    tmp_dir = out_dir / ".tmp" / asset_id
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        "python3",
        str(SKILL_SCRIPT),
        "--count",
        "1",
        "--model",
        prompt_def.get("model", "gpt-image-1"),
        "--size",
        prompt_def.get("size", "1024x1024"),
        "--quality",
        prompt_def.get("quality", "high"),
        "--prompt",
        prompt_def["prompt"],
        "--output-format",
        "png",
        "--background",
        "transparent" if prompt_def.get("kind") in {"sprite", "icon", "ui"} else "opaque",
        "--out-dir",
        str(tmp_dir),
    ]

    subprocess.run(cmd, check=True)

    generated = find_generated_image(tmp_dir)
    if generated is None:
        raise RuntimeError(f"No generated image found for asset '{asset_id}'")

    shutil.copy2(generated, target_path)

    return {
        "id": asset_id,
        "kind": prompt_def.get("kind", "unknown"),
        "path": f"/assets/generated/{target_path.name}",
        "source_prompt": prompt_def["prompt"],
        "model": prompt_def.get("model", "gpt-image-1"),
        "generated": True,
        "reused": False,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate game assets via OpenAI image skill")
    ap.add_argument("--prompts", default=str(DEFAULT_PROMPTS), help="Prompt JSON file")
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="Output directory")
    ap.add_argument("--dry-run", action="store_true", help="Do not call APIs, just write manifest")
    ap.add_argument("--skip-existing", action="store_true", help="Skip API calls for already existing asset files")
    ap.add_argument("--replace-manifest", action="store_true", help="Replace manifest instead of merging with existing")
    args = ap.parse_args()

    if not SKILL_SCRIPT.exists():
        print(f"Missing skill script: {SKILL_SCRIPT}", file=sys.stderr)
        return 2

    prompts_path = Path(args.prompts)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        prompt_defs = json.loads(prompts_path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"Failed to read prompts file: {exc}", file=sys.stderr)
        return 2

    if not isinstance(prompt_defs, list) or not prompt_defs:
        print("Prompt file must be a non-empty JSON array", file=sys.stderr)
        return 2

    assets = []
    failed_assets: list[str] = []
    for entry in prompt_defs:
        if not isinstance(entry, dict) or "id" not in entry or "prompt" not in entry:
            print(f"Skipping invalid prompt entry: {entry}", file=sys.stderr)
            continue
        print(f"Generating asset: {entry['id']}")
        try:
            assets.append(run_one(entry, out_dir, args.dry_run, args.skip_existing))
        except Exception as exc:
            failed_assets.append(str(entry["id"]))
            print(f"Failed to generate asset '{entry['id']}': {exc}", file=sys.stderr)
            continue

    merged_assets = assets
    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists() and not args.replace_manifest:
        try:
            existing_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            existing_assets = existing_manifest.get("assets", [])
            by_id: dict[str, dict] = {}
            for asset in existing_assets:
                if isinstance(asset, dict) and isinstance(asset.get("id"), str):
                    by_id[asset["id"]] = asset
            for asset in assets:
                by_id[asset["id"]] = asset
            merged_assets = [by_id[key] for key in sorted(by_id)]
        except Exception as exc:
            print(f"Warning: failed to merge existing manifest, writing fresh file: {exc}", file=sys.stderr)

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "openai-image-gen skill",
        "assets": merged_assets,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote manifest: {manifest_path}")
    if failed_assets:
        print(
            f"Asset generation completed with failures ({len(failed_assets)}): {', '.join(failed_assets)}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
