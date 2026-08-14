import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Source locator (ticket #210): maps a balance-parameter id to the exact
 * FILE and LINE a designer edits to apply a recommended change.
 *
 * It scans the live `Server/src/data/*.ts` sources at report time — never a
 * cached copy — so locations stay synchronized with the production engine:
 * if data moves, the locator follows. Locations are heuristic (the data
 * files are consistently formatted object literals) and each result carries
 * the located line's text so a reviewer can sanity-check at a glance.
 */

export interface SourceLocation {
  /** Repo-relative path, e.g. "Server/src/data/fireAbilities.ts". */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The located line's trimmed text. */
  snippet: string;
}

const DATA_DIR = fileURLToPath(new URL("../../src/data/", import.meta.url));

interface DataFile {
  name: string;
  lines: string[];
}

let cache: DataFile[] | null = null;
function dataFiles(): DataFile[] {
  if (cache) return cache;
  cache = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((name) => ({
      name,
      lines: readFileSync(path.join(DATA_DIR, name), "utf8").split(/\r?\n/),
    }));
  return cache;
}

/** For tests / long-lived processes: re-read the data sources. */
export function clearLocatorCache(): void {
  cache = null;
}

function repoPath(fileName: string): string {
  return `Server/src/data/${fileName}`;
}

function found(file: DataFile, index: number): SourceLocation {
  return {
    file: repoPath(file.name),
    line: index + 1,
    snippet: file.lines[index]!.trim(),
  };
}

/** First line matching `pattern` in [from, to). */
function findLine(
  file: DataFile,
  pattern: RegExp,
  from: number,
  to = file.lines.length,
): number {
  for (let i = from; i < Math.min(to, file.lines.length); i++) {
    if (pattern.test(file.lines[i]!)) return i;
  }
  return -1;
}

/** Balance.ts constant names per catalog id (mirrors parameterCatalog.ts). */
const BALANCE_KEYS: Record<string, string> = {
  "economy.incomePerCitizen": "INCOME_PER_CITIZEN",
  "economy.citizenCost": "CITIZEN_COST",
  "economy.citizenCostGrowth": "CITIZEN_COST_GROWTH",
  "citizens.startingCount": "STARTING_COUNT",
  "castle.startingHp": "STARTING_HP",
  "castle.repairAmount": "REPAIR_AMOUNT",
  "castle.repairCost": "REPAIR_COST",
  "castle.repairCostGrowth": "REPAIR_COST_GROWTH",
  "castle.maxRepairs": "MAX_REPAIRS",
  "shield.cost": "COST",
  "shield.standardHp": "STANDARD_HP",
  "combat.baseCritChance": "BASE_CRIT_CHANCE",
  "combat.baseCritMultiplier": "BASE_CRIT_MULTIPLIER",
  "targeting.switchCooldownTicks": "SWITCH_COOLDOWN_TICKS",
};

/** The section (exported const) a balance id lives in, to disambiguate keys
 *  like COST that appear in several sections. */
const BALANCE_SECTIONS: Record<string, string> = {
  economy: "ECONOMY",
  citizens: "CITIZENS",
  castle: "CASTLE",
  shield: "SHIELD",
  combat: "COMBAT",
  targeting: "TARGETING",
};

function locateBalance(id: string): SourceLocation | null {
  const key = BALANCE_KEYS[id];
  if (!key) return null;
  const section = BALANCE_SECTIONS[id.split(".")[0]!];
  const file = dataFiles().find((f) => f.name === "balance.ts");
  if (!file || !section) return null;

  const sectionStart = findLine(file, new RegExp(`export const ${section} = `), 0);
  if (sectionStart < 0) return null;
  const sectionEnd = findLine(file, /^\} as const;/, sectionStart);
  const hit = findLine(
    file,
    new RegExp(`^\\s*${key}:`),
    sectionStart,
    sectionEnd < 0 ? undefined : sectionEnd + 1,
  );
  return hit < 0 ? null : found(file, hit);
}

/** Bounds of the ability object literal that declares `id: "<abilityId>"`. */
function abilityRange(
  abilityId: string,
): { file: DataFile; start: number; end: number } | null {
  for (const file of dataFiles()) {
    const start = findLine(file, new RegExp(`^\\s*id: "${abilityId}",`), 0);
    if (start < 0) continue;
    // The definition ends at the next top-level export (or EOF).
    let end = findLine(file, /^export /, start + 1);
    if (end < 0) end = file.lines.length;
    return { file, start, end };
  }
  return null;
}

function locateAbility(abilityId: string, rest: string[]): SourceLocation | null {
  const range = abilityRange(abilityId);
  if (!range) return null;
  const { file, start, end } = range;
  const [head, ...tail] = rest;

  // Top-of-definition scalar fields — matched before nested sections begin.
  const sectionStart = (name: string) => findLine(file, new RegExp(`^\\s*${name}: \\[|^\\s*${name}: \\{`), start, end);
  const effectsAt = sectionStart("effects");
  const upgradesAt = sectionStart("upgradePath");
  const chargeAt = sectionStart("chargeSystem");
  const bodyEnd = Math.min(
    ...[effectsAt, upgradesAt, end].filter((n) => n >= 0),
  );

  if (head === "cost" || head === "cooldownTicks" || head === "unlockCost") {
    const hit = findLine(file, new RegExp(`^\\s*${head}:`), start, bodyEnd);
    // unlockCost may be implicit (50% of cost) — point at the definition head.
    return hit < 0 ? found(file, start) : found(file, hit);
  }

  if (head === "charge" && chargeAt >= 0) {
    const chargeEnd = findLine(file, /^\s*\},/, chargeAt);
    const field = tail[0]!;
    if (field === "damage") {
      const hit = findLine(file, /^\s*damageByCharges:/, chargeAt, chargeEnd + 1);
      return hit < 0 ? found(file, chargeAt) : found(file, hit);
    }
    const hit = findLine(file, new RegExp(`^\\s*${field}:`), chargeAt, chargeEnd + 1);
    return hit < 0 ? found(file, chargeAt) : found(file, hit);
  }

  if (head === "effects" && effectsAt >= 0) {
    const index = Number(tail[0]);
    const key = tail[1]!;
    const effectsEnd = upgradesAt >= 0 ? upgradesAt : end;
    // Walk to the (index+1)-th effect: effects are `{ type: ... }` entries.
    let cursor = effectsAt;
    for (let i = 0; i <= index; i++) {
      cursor = findLine(file, /^\s*(\{\s*)?type: "/u, cursor + 1, effectsEnd);
      if (cursor < 0) return found(file, effectsAt);
    }
    const nextEffect = findLine(file, /^\s*(\{\s*)?type: "/u, cursor + 1, effectsEnd);
    const effectEnd = nextEffect < 0 ? effectsEnd : nextEffect;
    // Params may sit on their own line or inline: `params: { amount: 250, … }`.
    const hit = findLine(
      file,
      new RegExp(`(^\\s*|[{,]\\s*)${key}:`),
      cursor,
      effectEnd,
    );
    return hit < 0 ? found(file, cursor) : found(file, hit);
  }

  if (head === "upgrade" && upgradesAt >= 0) {
    const level = Number(tail[0]);
    const tierAt = findLine(
      file,
      new RegExp(`^\\s*level: ${level},`),
      upgradesAt,
      end,
    );
    if (tierAt < 0) return found(file, upgradesAt);
    const hit = findLine(file, /^\s*cost:/, tierAt, tierAt + 4);
    return hit < 0 ? found(file, tierAt) : found(file, hit);
  }

  return found(file, start);
}

function locatePassive(kingdomId: string, index: number, field: string): SourceLocation | null {
  const file = dataFiles().find((f) => f.name === "kingdoms.ts");
  if (!file) return null;
  const mapStart = findLine(file, /export const KINGDOM_PASSIVES/, 0);
  if (mapStart < 0) return null;
  const kingdomAt = findLine(file, new RegExp(`^\\s*${kingdomId}: \\[`), mapStart);
  if (kingdomAt < 0) return null;
  const kingdomEnd = findLine(file, /^\s*\],/, kingdomAt);

  // Walk to the (index+1)-th passive entry (`{ type: ... }`).
  let cursor = kingdomAt;
  for (let i = 0; i <= index; i++) {
    cursor = findLine(file, /^\s*\{ type: "/, cursor + 1, kingdomEnd + 1);
    if (cursor < 0) return found(file, kingdomAt);
  }
  // Single-line passive entries carry the field on the same line; otherwise
  // scan the entry block.
  if (new RegExp(`${field}:`).test(file.lines[cursor]!)) return found(file, cursor);
  const hit = findLine(file, new RegExp(`^\\s*${field}:`), cursor, kingdomEnd + 1);
  return hit < 0 ? found(file, cursor) : found(file, hit);
}

/**
 * Locates where a parameter's production value is defined. Returns null only
 * for unknown id shapes; known shapes always return at least the enclosing
 * definition's location.
 */
export function locateParameter(id: string): SourceLocation | null {
  const parts = id.split(".");
  if (parts[0] === "ability" && parts.length >= 3) {
    return locateAbility(parts[1]!, parts.slice(2));
  }
  if (parts[0] === "passive" && parts.length === 4) {
    return locatePassive(parts[1]!, Number(parts[2]), parts[3]!);
  }
  return locateBalance(id);
}
