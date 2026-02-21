#!/usr/bin/env python3
"""Build a combined OpenAI asset prompt pack for characters + in-game items + NPCs.

The item/NPC lists are extracted from source-of-truth gameplay files so the prompt
pack tracks whatever the game currently references.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_PROMPTS_PATH = ROOT / "assets" / "prompts" / "openai-f2p-assets.json"
OUTPUT_PATH = ROOT / "assets" / "prompts" / "openai-game-full-assets.json"

ITEM_SOURCE_FILES = [
    ROOT / "src" / "world.ts",
    ROOT / "src" / "quests.ts",
    ROOT / "src" / "routes.ts",
    ROOT / "public" / "game.html",
]
NPC_SOURCE_FILES = [
    ROOT / "src" / "quests.ts",
    ROOT / "public" / "game.html",
]

CHARACTER_VARIANTS = [
    {
        "id": "player_melee_iron",
        "kind": "sprite",
        "size": "1024x1536",
        "quality": "high",
        "model": "gpt-image-1",
        "prompt": "full-body fantasy melee fighter, iron plate armor, kite shield and sword, old-school MMORPG 2007-inspired low-detail painterly style, clean silhouette, transparent background",
    },
    {
        "id": "player_melee_berserker",
        "kind": "sprite",
        "size": "1024x1536",
        "quality": "high",
        "model": "gpt-image-1",
        "prompt": "full-body fantasy berserker warrior, heavy red armor and two-handed blade, old-school MMORPG 2007-inspired low-detail painterly style, clean silhouette, transparent background",
    },
    {
        "id": "player_ranged_hunter",
        "kind": "sprite",
        "size": "1024x1536",
        "quality": "high",
        "model": "gpt-image-1",
        "prompt": "full-body fantasy ranger hunter, green hooded leather armor and longbow, old-school MMORPG 2007-inspired low-detail painterly style, clean silhouette, transparent background",
    },
    {
        "id": "player_ranged_scout",
        "kind": "sprite",
        "size": "1024x1536",
        "quality": "high",
        "model": "gpt-image-1",
        "prompt": "full-body fantasy ranged scout, blue-green leather armor and crossbow, old-school MMORPG 2007-inspired low-detail painterly style, clean silhouette, transparent background",
    },
    {
        "id": "player_magic_sage",
        "kind": "sprite",
        "size": "1024x1536",
        "quality": "high",
        "model": "gpt-image-1",
        "prompt": "full-body fantasy arcane sage, indigo robes and rune staff, old-school MMORPG 2007-inspired low-detail painterly style, clean silhouette, transparent background",
    },
    {
        "id": "player_magic_battlemage",
        "kind": "sprite",
        "size": "1024x1536",
        "quality": "high",
        "model": "gpt-image-1",
        "prompt": "full-body fantasy battle mage, dark robes with glowing runes and crystal staff, old-school MMORPG 2007-inspired low-detail painterly style, clean silhouette, transparent background",
    },
]

NPC_LABELS = {
    "guide": "Gielinor Guide",
    "hans": "Hans",
    "shopkeeper": "Shop Keeper",
    "guildmaster": "Guild Master",
    "ozyach": "Oziach",
    "emir_herald": "Emir's Herald",
    "wilderness_warning": "Border Guard",
    "arena_master": "Arena Master",
    "rune_sage": "Rune Sage",
    "depths_watcher": "Depths Watcher",
    "shadow_keeper": "Shadow Keeper",
    "guild_registrar": "Skills Registrar",
    "quest_oracle": "Quest Oracle",
    "sir_amik": "Sir Amik",
    "cook": "Cook",
    "gypsy_aris": "Gypsy Aris",
    "doric": "Doric",
    "veronica": "Veronica",
    "general_bentnoze": "General Bentnoze",
    "wizard_mizgog": "Wizard Mizgog",
    "squire": "Squire",
    "redbeard_frank": "Redbeard Frank",
    "hassan": "Hassan",
    "father_aereck": "Father Aereck",
    "romeo": "Romeo",
    "duke_horacio": "Duke Horacio",
    "fred_farmer": "Fred Farmer",
    "reldo": "Reldo",
    "morgan": "Morgan",
    "hetty": "Hetty",
}


def titleize(item_id: str) -> str:
    return item_id.replace("_", " ")


def build_item_prompt(item_id: str) -> str:
    label = titleize(item_id)
    if item_id.endswith("_rune"):
        return f"single inventory icon of {label}, magical carved rune, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    if item_id.endswith("_ore"):
        return f"single inventory icon of {label}, rough mining ore rock, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    if item_id.endswith("_logs"):
        return f"single inventory icon of {label}, chopped wood bundle, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    if item_id.startswith("raw_") or item_id.startswith("cooked_"):
        return f"single inventory icon of {label}, food item for fantasy RPG, old-school MMORPG item icon, centered object, transparent background, no text"
    if "bar" in item_id:
        return f"single inventory icon of {label}, forged metal bar, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    if item_id in {"godsword", "crossbow", "staff"}:
        return f"single inventory icon of {label}, equipped weapon art, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    if item_id in {"torva", "armadyl", "ancestral"}:
        return f"single inventory icon of {label}, armor set emblem, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    if item_id in {"coins", "coin_pouch", "ancient_coin"}:
        return f"single inventory icon of {label}, stack of fantasy coins, old-school fantasy MMORPG item icon, centered object, transparent background, no text"
    return f"single inventory icon of {label}, old-school fantasy MMORPG item icon, centered object, transparent background, no text"


def build_npc_prompt(npc_id: str) -> str:
    label = NPC_LABELS.get(npc_id, titleize(npc_id).title())
    if any(token in npc_id for token in ("wizard", "sage", "oracle", "gypsy", "hetty")):
        role = "arcane spellcaster NPC"
    elif any(token in npc_id for token in ("sir", "duke", "squire", "guild", "guard", "master", "watcher")):
        role = "armored medieval guard NPC"
    elif any(token in npc_id for token in ("farmer", "cook", "shopkeeper", "hans", "hassan")):
        role = "town civilian NPC"
    elif any(token in npc_id for token in ("goblin", "bentnoze")):
        role = "goblin chief NPC"
    elif "redbeard" in npc_id:
        role = "pirate NPC"
    else:
        role = "fantasy town NPC"

    return (
        f"full-body {role} named {label}, old-school fantasy MMORPG 2007-inspired "
        "painterly sprite style, clean silhouette, transparent background, no text"
    )


def extract_item_ids() -> list[str]:
    item_ids: set[str] = set()

    for path in ITEM_SOURCE_FILES:
        text = path.read_text(encoding="utf-8")
        item_ids.update(re.findall(r'item_id\s*:\s*"([a-z0-9_]+)"', text))

        for runes_block in re.findall(r"runes\s*:\s*\{([^}]+)\}", text, flags=re.S):
            item_ids.update(re.findall(r"([a-z0-9_]+)\s*:", runes_block))

        for items_block in re.findall(r"items\s*:\s*\{([^}]+)\}", text, flags=re.S):
            item_ids.update(re.findall(r"([a-z0-9_]+)\s*:", items_block))

        item_ids.update(re.findall(r"inventory\.([a-z0-9_]+)\s*=", text))

    game_text = (ROOT / "public" / "game.html").read_text(encoding="utf-8")
    for slot in ("weapon", "armor", "cape"):
        item_ids.update(re.findall(rf"{slot}\s*:\s*'([a-z0-9_]+)'", game_text))

    blocked = {"none", "start", "stop", "buy", "sell"}
    return sorted(item for item in item_ids if item not in blocked)


def extract_npc_ids() -> list[str]:
    npc_ids: set[str] = set()

    for path in NPC_SOURCE_FILES:
        text = path.read_text(encoding="utf-8")
        npc_ids.update(re.findall(r'giver_npc_id\s*:\s*"([a-z0-9_]+)"', text))
        npc_ids.update(re.findall(r'turn_in_npc_id\s*:\s*"([a-z0-9_]+)"', text))

        if path.name == "game.html":
            npcs_block = re.search(r"const\s+npcs\s*=\s*\[(.*?)\];", text, flags=re.S)
            if npcs_block:
                npc_ids.update(re.findall(r"(?<![a-z0-9_])id:\s*'([a-z0-9_]+)'", npcs_block.group(1)))

            quest_npcs_block = re.search(
                r"const\s+questNpcProfiles\s*=\s*\[(.*?)\];",
                text,
                flags=re.S,
            )
            if quest_npcs_block:
                npc_ids.update(re.findall(r"(?<![a-z0-9_])id:\s*'([a-z0-9_]+)'", quest_npcs_block.group(1)))

    blocked = {"none", "start", "stop", "buy", "sell"}
    return sorted(npc for npc in npc_ids if npc not in blocked)


def build_item_assets(item_ids: list[str]) -> list[dict]:
    return [
        {
            "id": f"item_{item_id}",
            "kind": "icon",
            "size": "1024x1024",
            "quality": "medium",
            "model": "gpt-image-1",
            "prompt": build_item_prompt(item_id),
            "item_id": item_id,
        }
        for item_id in item_ids
    ]


def build_npc_assets(npc_ids: list[str]) -> list[dict]:
    return [
        {
            "id": f"npc_{npc_id}",
            "kind": "sprite",
            "size": "1024x1536",
            "quality": "high",
            "model": "gpt-image-1",
            "prompt": build_npc_prompt(npc_id),
            "npc_id": npc_id,
        }
        for npc_id in npc_ids
    ]


def main() -> int:
    base_prompts = json.loads(BASE_PROMPTS_PATH.read_text(encoding="utf-8"))
    item_ids = extract_item_ids()
    npc_ids = extract_npc_ids()
    item_prompts = build_item_assets(item_ids)
    npc_prompts = build_npc_assets(npc_ids)

    by_id: dict[str, dict] = {}
    for prompt in base_prompts:
        by_id[prompt["id"]] = prompt
    for prompt in CHARACTER_VARIANTS:
        by_id[prompt["id"]] = prompt
    for prompt in npc_prompts:
        by_id[prompt["id"]] = prompt
    for prompt in item_prompts:
        by_id[prompt["id"]] = prompt

    combined = [by_id[key] for key in sorted(by_id)]
    OUTPUT_PATH.write_text(json.dumps(combined, indent=2), encoding="utf-8")

    print(f"Wrote prompt pack: {OUTPUT_PATH}")
    print(f"Base assets: {len(base_prompts)}")
    print(f"Character variants: {len(CHARACTER_VARIANTS)}")
    print(f"NPC assets: {len(npc_prompts)}")
    print(f"Item assets: {len(item_prompts)}")
    print(f"Total assets: {len(combined)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
