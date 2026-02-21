#!/usr/bin/env python3
"""Synthesize fallback NPC sprites for missing npc_* assets.

This script is used when external image generation is unavailable (for example
billing or API key issues). It creates deterministic sprite variants from
existing generated NPC images so every quest/world NPC has a dedicated sprite id.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "public" / "assets" / "generated"
MANIFEST_PATH = ASSET_DIR / "manifest.json"
PROMPTS_PATH = ROOT / "assets" / "prompts" / "openai-game-full-assets.json"


def hex_color(seed: str) -> tuple[int, int, int]:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    # keep tones in readable fantasy range
    return (80 + digest[0] % 160, 80 + digest[1] % 160, 80 + digest[2] % 160)


def pick_source(sprite_ids: list[str], target_id: str) -> str:
    digest = hashlib.sha256(target_id.encode("utf-8")).digest()
    return sprite_ids[digest[0] % len(sprite_ids)]


def tint_sprite(base: Image.Image, accent: tuple[int, int, int], target_id: str) -> Image.Image:
    img = base.convert("RGBA")
    overlay = Image.new("RGBA", img.size, (*accent, 76))
    tinted = Image.alpha_composite(img, overlay)

    draw = ImageDraw.Draw(tinted, "RGBA")
    w, h = tinted.size

    # Add a deterministic shoulder sash/trim for variation.
    digest = hashlib.sha256(target_id.encode("utf-8")).digest()
    x1 = int(w * (0.25 + (digest[1] % 20) / 100))
    y1 = int(h * 0.38)
    x2 = int(w * (0.72 + (digest[2] % 10) / 100))
    y2 = int(h * 0.56)
    trim = (255 - accent[0] // 2, 255 - accent[1] // 2, 255 - accent[2] // 2, 120)
    draw.rectangle((x1, y1, x2, y2), outline=trim, width=6)

    # Add a subtle crest dot.
    cx = int(w * (0.46 + (digest[3] % 12 - 6) / 100))
    cy = int(h * 0.28)
    r = max(6, int(min(w, h) * 0.015))
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*trim[:3], 150))

    return tinted


def main() -> int:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    prompts = json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))

    prompt_by_id = {entry["id"]: entry for entry in prompts if isinstance(entry, dict) and "id" in entry}
    existing_assets = manifest.get("assets", [])
    by_id: dict[str, dict] = {
        asset["id"]: asset for asset in existing_assets if isinstance(asset, dict) and isinstance(asset.get("id"), str)
    }

    wanted_npc_ids = sorted(entry_id for entry_id in prompt_by_id if entry_id.startswith("npc_"))
    existing_npc_ids = sorted(entry_id for entry_id in by_id if entry_id.startswith("npc_"))
    missing = [entry_id for entry_id in wanted_npc_ids if entry_id not in by_id]

    if not existing_npc_ids:
        raise RuntimeError("No base npc sprites found to synthesize from.")

    created = []
    for target_id in missing:
        source_id = pick_source(existing_npc_ids, target_id)
        source_path = ASSET_DIR / f"{source_id}.png"
        target_path = ASSET_DIR / f"{target_id}.png"
        if not source_path.exists():
            continue

        accent = hex_color(target_id)
        with Image.open(source_path) as src:
            out = tint_sprite(src, accent, target_id)
            out.save(target_path, "PNG")

        prompt = prompt_by_id.get(target_id, {})
        by_id[target_id] = {
            "id": target_id,
            "kind": prompt.get("kind", "sprite"),
            "path": f"/assets/generated/{target_path.name}",
            "source_prompt": prompt.get("prompt", f"fallback synthesized sprite for {target_id}"),
            "model": "local-synth-fallback",
            "generated": True,
            "reused": False,
            "fallback_generated": True,
            "fallback_source_id": source_id,
        }
        created.append(target_id)

    manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
    manifest["source"] = "openai-image-gen skill + local synth fallback"
    manifest["assets"] = [by_id[key] for key in sorted(by_id)]
    MANIFEST_PATH.write_text(f"{json.dumps(manifest, indent=2)}\n", encoding="utf-8")

    print(f"missing_before={len(missing)}")
    print(f"created={len(created)}")
    for entry_id in created:
        print(entry_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
