import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const INDEX_PATH = path.join(ROOT, "index.html");
const OUTPUT_JS_PATH = path.join(ROOT, "data", "belgrade-streets-offline.js");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const SEARCH_BBOXES = [
  { label: "центр Стари Град", value: "44.800,20.442,44.833,20.492" },
  { label: "расширенный центр", value: "44.790,20.430,44.845,20.510" },
  { label: "большой центр Белграда", value: "44.770,20.400,44.865,20.540" },
];

const normalizeKey = (value) => {
  let key = (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  key = key
    .replace(/đ/g, "dj")
    .replace(/џ/g, "dz")
    .replace(/љ/g, "lj")
    .replace(/њ/g, "nj")
    .replace(/ћ/g, "c")
    .replace(/č/g, "c")
    .replace(/ž/g, "z")
    .replace(/š/g, "s");
  return key.replace(/[^a-z0-9\u0400-\u04ff]+/g, "");
};

const makeAliases = (name) => {
  if (!name) return [];
  const aliases = new Set([name.trim()]);
  aliases.add(name.replace(/\./g, "").trim());
  aliases.add(name.replace(/\s+/g, " ").trim());
  aliases.add(name.replace(/^BUL\.?\s+/i, "BULEVAR ").trim());
  aliases.add(name.replace(/^BULEVAR\s+/i, "BUL. ").trim());
  aliases.add(name.replace(/^БУЛ\.?\s+/i, "БУЛЕВАР ").trim());
  aliases.add(name.replace(/^БУЛЕВАР\s+/i, "БУЛ. ").trim());
  return [...aliases].filter(Boolean);
};

const parseStreetData = (raw) => {
  const rows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return rows
    .map((line) => {
      const match = line.match(/^(\d+),([^,]+),([^,]+),([^,]+),(.*)$/);
      if (!match) return null;

      const [, id, nameCyr, nameLat, zoneRaw, noteRaw] = match;
      return {
        id: Number(id),
        nameCyr: nameCyr.trim(),
        nameLat: nameLat.trim(),
        zone: zoneRaw.trim(),
        note: noteRaw.trim().replace(/^"(.*)"$/, "$1"),
      };
    })
    .filter(Boolean);
};

const buildZoneIndex = (streets) => {
  const zoneIndex = new Map();
  for (const street of streets) {
    if (!zoneIndex.has(street.zone)) {
      zoneIndex.set(street.zone, new Map());
    }
    const byName = zoneIndex.get(street.zone);
    const aliases = [...makeAliases(street.nameCyr), ...makeAliases(street.nameLat)];

    for (const alias of aliases) {
      const key = normalizeKey(alias);
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(street);
    }
  }
  return zoneIndex;
};

const findMatchedStreets = (tags, zoneNameIndex) => {
  const values = [
    tags?.name,
    tags?.["name:sr"],
    tags?.["name:sr-Latn"],
    tags?.official_name,
    tags?.alt_name,
  ].filter(Boolean);

  const found = new Map();
  for (const value of values) {
    const key = normalizeKey(value);
    if (!key) continue;
    const directHits = zoneNameIndex.get(key) || [];
    for (const street of directHits) {
      found.set(street.id, street);
    }

    if (directHits.length === 0) {
      for (const [aliasKey, streetsByAlias] of zoneNameIndex.entries()) {
        if (aliasKey.length < 8) continue;
        if (key.includes(aliasKey) || aliasKey.includes(key)) {
          for (const street of streetsByAlias) {
            found.set(street.id, street);
          }
        }
      }
    }
  }

  return [...found.values()];
};

const buildSegment = (way, zone, matchedStreets) => {
  if (!Array.isArray(way.geometry) || way.geometry.length < 2) return null;
  const latLngs = way.geometry.map((point) => [point.lat, point.lon]);
  const name =
    way.tags?.["name:sr-Latn"] ||
    way.tags?.name ||
    way.tags?.["name:sr"] ||
    way.tags?.official_name ||
    "Улица";

  return {
    zone,
    name,
    latLngs,
    streetIds: [...new Set(matchedStreets.map((street) => street.id))],
    notes: [...new Set(matchedStreets.map((street) => street.note).filter(Boolean))],
  };
};

const buildMatchedResult = (ways, zoneNameIndex) => {
  const segments12 = [];
  const segmentsB1 = [];
  const found12 = new Set();
  const foundB1 = new Set();

  for (const way of ways) {
    const matched12 = findMatchedStreets(way.tags || {}, zoneNameIndex.get("1.2"));
    if (matched12.length > 0) {
      const segment = buildSegment(way, "1.2", matched12);
      if (segment) segments12.push(segment);
      for (const street of matched12) found12.add(street.id);
    }

    const matchedB1 = findMatchedStreets(way.tags || {}, zoneNameIndex.get("Б.1"));
    if (matchedB1.length > 0) {
      const segment = buildSegment(way, "Б.1", matchedB1);
      if (segment) segmentsB1.push(segment);
      for (const street of matchedB1) foundB1.add(street.id);
    }
  }

  return {
    segments12,
    segmentsB1,
    found12,
    foundB1,
    zone12Added: segments12.length,
    zoneB1Added: segmentsB1.length,
  };
};

const buildOverpassQuery = (bbox) => `
[out:json][timeout:180];
(
  way["highway"]["name"](${bbox});
  way["highway"]["name:sr"](${bbox});
  way["highway"]["name:sr-Latn"](${bbox});
  way["highway"]["official_name"](${bbox});
);
out body geom;
`.trim();

const fetchWaysByBBox = async (bbox) => {
  const query = buildOverpassQuery(bbox);
  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      let response = await fetch(endpoint, { method: "POST", body: query });
      if (!response.ok) {
        response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, { method: "GET" });
      }
      if (!response.ok) throw new Error(`${endpoint}: ${response.status}`);
      const payload = await response.json();
      const seen = new Set();
      const ways = [];
      for (const el of payload.elements || []) {
        if (el.type !== "way") continue;
        if (seen.has(el.id)) continue;
        seen.add(el.id);
        ways.push(el);
      }
      return ways;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("No Overpass endpoints available");
};

const extractRawStreetData = async () => {
  const html = await fs.readFile(INDEX_PATH, "utf8");
  const match = html.match(/const rawStreetData = `([\s\S]*?)`\.trim\(\);/);
  if (!match) throw new Error("rawStreetData block not found in index.html");
  return match[1].trim();
};

const main = async () => {
  const rawStreetData = await extractRawStreetData();
  const streets = parseStreetData(rawStreetData);
  const zoneNameIndex = buildZoneIndex(streets);

  let best = null;
  let bestBBoxLabel = "";
  let bestTotal = -1;

  for (const bbox of SEARCH_BBOXES) {
    const ways = await fetchWaysByBBox(bbox.value);
    const result = buildMatchedResult(ways, zoneNameIndex);
    const totalMatched = result.found12.size + result.foundB1.size;
    if (!best || totalMatched > bestTotal) {
      best = result;
      bestTotal = totalMatched;
      bestBBoxLabel = bbox.label;
    }
    if (totalMatched >= 36) break;
  }

  if (!best) throw new Error("No data matched");

  const payload = {
    version: 1,
    savedAt: Date.now(),
    source: "bundled-offline",
    bboxLabel: bestBBoxLabel,
    segments12: best.segments12,
    segmentsB1: best.segmentsB1,
    found12: [...best.found12],
    foundB1: [...best.foundB1],
  };

  await fs.writeFile(
    OUTPUT_JS_PATH,
    `window.BELGRADE_OFFLINE_DATA = ${JSON.stringify(payload, null, 2)};\n`,
    "utf8"
  );
  console.log(
    `offline data written: ${OUTPUT_JS_PATH} | seg 1.2=${payload.segments12.length} seg Б.1=${payload.segmentsB1.length}`
  );
  console.log(`matched streets: 1.2=${payload.found12.length}, Б.1=${payload.foundB1.length}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
