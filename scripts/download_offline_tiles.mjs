import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const TILE_ROOT = path.join(ROOT, "tiles");
const BASE_URL = "https://tile.openstreetmap.org";

const BBOX_WIDE = {
  minLat: 44.75,
  maxLat: 44.89,
  minLon: 20.34,
  maxLon: 20.58,
};

const BBOX_TIGHT = {
  minLat: 44.8,
  maxLat: 44.835,
  minLon: 20.44,
  maxLon: 20.495,
};

const ZOOM_PLANS = [
  { zooms: [15, 16], bbox: BBOX_WIDE },
  { zooms: [17, 18, 19], bbox: BBOX_TIGHT },
];
const CONCURRENCY = 8;
const RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lon2tile = (lon, z) => Math.floor(((lon + 180) / 360) * Math.pow(2, z));
const lat2tile = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z)
  );
};

const buildTileList = () => {
  const list = [];
  for (const plan of ZOOM_PLANS) {
    for (const z of plan.zooms) {
      const xMin = lon2tile(plan.bbox.minLon, z);
      const xMax = lon2tile(plan.bbox.maxLon, z);
      const yMin = lat2tile(plan.bbox.maxLat, z);
      const yMax = lat2tile(plan.bbox.minLat, z);
      for (let x = xMin; x <= xMax; x += 1) {
        for (let y = yMin; y <= yMax; y += 1) {
          list.push({ z, x, y });
        }
      }
    }
  }
  return list;
};

const downloadOne = async (tile) => {
  const { z, x, y } = tile;
  const dir = path.join(TILE_ROOT, String(z), String(x));
  const target = path.join(dir, `${y}.png`);
  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.access(target);
    return { ok: true, skipped: true };
  } catch {
    // continue
  }

  const url = `${BASE_URL}/${z}/${x}/${y}.png`;
  let lastError;
  for (let i = 1; i <= RETRIES; i += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "OfflineBelgradeMap/1.0 (local generation)",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(target, data);
      return { ok: true, skipped: false };
    } catch (error) {
      lastError = error;
      await sleep(350 * i);
    }
  }
  return { ok: false, error: String(lastError) };
};

const runPool = async (tiles) => {
  let idx = 0;
  let done = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  const worker = async () => {
    while (true) {
      const current = idx;
      idx += 1;
      if (current >= tiles.length) break;
      const result = await downloadOne(tiles[current]);
      done += 1;
      if (result.ok && result.skipped) skipped += 1;
      else if (result.ok) downloaded += 1;
      else failed += 1;

      if (done % 20 === 0 || done === tiles.length) {
        console.log(
          `progress ${done}/${tiles.length} | downloaded=${downloaded} skipped=${skipped} failed=${failed}`
        );
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return { downloaded, skipped, failed };
};

const main = async () => {
  const tiles = buildTileList();
  console.log(`tiles to ensure: ${tiles.length}`);
  const result = await runPool(tiles);
  console.log(
    `done | downloaded=${result.downloaded} skipped=${result.skipped} failed=${result.failed}`
  );
  if (result.failed > 0) process.exit(1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
