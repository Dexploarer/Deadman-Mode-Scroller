#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type AssetManifest = {
  assets: Array<{
    id: string;
    kind?: string;
    blob_url?: string;
  }>;
};

const MANIFEST_PATH = "public/assets/generated/manifest.json";
const OUTPUT_CSV = "assets/figma/asset-catalog.csv";
const OUTPUT_MD = "assets/figma/asset-catalog.md";

function categoryFor(id: string): string {
  if (id.startsWith("player_")) return "player";
  if (id.startsWith("npc_")) return "npc";
  if (id.startsWith("item_")) return "item";
  if (id.startsWith("bg_")) return "background";
  if (id.startsWith("ui_")) return "ui";
  return "misc";
}

async function main(): Promise<void> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`);
  }

  const manifest = (await file.json()) as AssetManifest;
  const rows = manifest.assets
    .filter((asset) => asset.blob_url)
    .map((asset) => ({
      id: asset.id,
      kind: asset.kind ?? "unknown",
      category: categoryFor(asset.id),
      blobUrl: asset.blob_url!,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  mkdirSync(dirname(OUTPUT_CSV), { recursive: true });

  const csv = [
    "id,kind,category,url",
    ...rows.map(
      (row) =>
        `${row.id},${row.kind},${row.category},${JSON.stringify(row.blobUrl)}`,
    ),
  ].join("\n");
  await Bun.write(OUTPUT_CSV, `${csv}\n`);

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const current = grouped.get(row.category) ?? [];
    current.push(row);
    grouped.set(row.category, current);
  }

  const mdLines: string[] = [
    "# RuneScape Arena Asset Catalog",
    "",
    `- Source: \`${MANIFEST_PATH}\``,
    `- Total assets: ${rows.length}`,
    "",
  ];

  for (const [category, items] of [...grouped.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    mdLines.push(`## ${category}`);
    mdLines.push("");
    for (const item of items) {
      mdLines.push(`- ${item.id}: ${item.blobUrl}`);
    }
    mdLines.push("");
  }

  await Bun.write(OUTPUT_MD, `${mdLines.join("\n")}\n`);
  console.log(`[written] ${OUTPUT_CSV}`);
  console.log(`[written] ${OUTPUT_MD}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
