#!/usr/bin/env bun
import { put } from "@vercel/blob";
import { basename, join } from "node:path";

type ManifestAsset = {
  id: string;
  kind: string;
  path: string;
  source_prompt?: string;
  model?: string;
  generated?: boolean;
  reused?: boolean;
  blob_url?: string;
  blob_path?: string;
  blob_download_url?: string;
  blob_uploaded_at?: string;
};

type ManifestFile = {
  generated_at: string;
  source: string;
  assets: ManifestAsset[];
  blob_synced_at?: string;
};

type CliOptions = {
  manifestPath: string;
  prefix: string;
  dryRun: boolean;
  skipExisting: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  let manifestPath = "public/assets/generated/manifest.json";
  let prefix = "runescape-arena/assets/generated";
  let dryRun = false;
  let skipExisting = false;

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--manifest" && argv[i + 1]) {
      manifestPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--prefix" && argv[i + 1]) {
      prefix = argv[i + 1];
      i += 1;
      continue;
    }
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--skip-existing") {
      skipExisting = true;
      continue;
    }
  }

  return { manifestPath, prefix, dryRun, skipExisting };
}

function resolveLocalPath(pathname: string): string {
  const cleaned = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (cleaned.startsWith("assets/")) {
    return join(process.cwd(), "public", cleaned);
  }
  return join(process.cwd(), cleaned);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!options.dryRun && !token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is required");
  }
  const manifestFile = Bun.file(options.manifestPath);
  if (!(await manifestFile.exists())) {
    throw new Error(`Manifest not found at ${options.manifestPath}`);
  }

  const manifest = (await manifestFile.json()) as ManifestFile;
  const nowIso = new Date().toISOString();

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const asset of manifest.assets) {
    const localPath = resolveLocalPath(asset.path);
    const sourceFile = Bun.file(localPath);

    if (!(await sourceFile.exists())) {
      console.error(`[missing] ${asset.id} -> ${localPath}`);
      failed += 1;
      continue;
    }

    if (options.skipExisting && asset.blob_url) {
      console.log(`[skip-existing] ${asset.id} -> ${asset.blob_url}`);
      skipped += 1;
      continue;
    }

    const remotePath = `${options.prefix}/${basename(localPath)}`;
    if (options.dryRun) {
      console.log(`[dry-run] ${asset.id}: ${localPath} -> ${remotePath}`);
      skipped += 1;
      continue;
    }

    try {
      const result = await put(remotePath, sourceFile, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "image/png",
        token: token!,
      });

      asset.blob_url = result.url;
      asset.blob_path = result.pathname;
      asset.blob_download_url = result.downloadUrl;
      asset.blob_uploaded_at = nowIso;

      console.log(`[uploaded] ${asset.id} -> ${result.url}`);
      uploaded += 1;
    } catch (error) {
      console.error(`[error] ${asset.id}:`, error);
      failed += 1;
    }
  }

  if (!options.dryRun) {
    manifest.blob_synced_at = nowIso;
    await Bun.write(
      options.manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const urlMap = Object.fromEntries(
      manifest.assets
        .filter((asset) => Boolean(asset.blob_url))
        .map((asset) => [asset.id, asset.blob_url]),
    );
    const blobMapPath = "public/assets/generated/blob-urls.json";
    await Bun.write(blobMapPath, `${JSON.stringify(urlMap, null, 2)}\n`);
    console.log(`[written] ${options.manifestPath}`);
    console.log(`[written] ${blobMapPath}`);
  }

  console.log(
    `[done] uploaded=${uploaded} skipped=${skipped} failed=${failed} total=${manifest.assets.length}`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
