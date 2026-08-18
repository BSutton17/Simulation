/**
 * What a seat may legitimately know.
 *
 * This is the specification of the information boundary, kept as a flat table
 * of pure data rather than as logic, so the rule can be REVIEWED as a list
 * instead of reverse-engineered out of a projection. `knowledge.ts` is the only
 * module that applies it.
 *
 * ── WHERE THE RULE COMES FROM ─────────────────────────────────────────────
 *
 * The authority is the game client, which decides what is actually drawn:
 *
 *     elementals/Client/src/components/BattlefieldView.tsx:470
 *         showStats={spectator || isYou || hasAirVision || deadSeesAll}
 *
 * That single expression gates the HP bar, the shield bar, the citizen count
 * and the income readout for a kingdom (`KingdomSite.tsx:188` and `:277`). By
 * default a player therefore sees NONE of those for an enemy — not "sees a
 * rounded number", sees nothing. Enemy gold and enemy cooldowns are not
 * rendered under any condition, including a full reveal.
 *
 * ⚠️ That file lives in a repository this one does not contain and cannot
 * import, so the table below is a hand-maintained transcription of a rule owned
 * elsewhere. It can drift when the client changes. Nothing here can prevent
 * that; what it can do is make the drift cheap to find — every gated row cites
 * the client file it transcribes, and `visibilitySpecHash()` is pinned by a
 * test, so widening the rule cannot happen without a deliberate version bump.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * The server broadcasts the whole `PlayerState` for every player to every
 * client (`net/gameSync.ts` spreads `{...p}`), so the wire already carries
 * every enemy's exact gold, income, cooldowns and meters. Only the UI declines
 * to draw them. An AI reading the simulation directly would therefore be
 * playing a materially different game from the human beside it, and would learn
 * decisions no person could make ("do not attack, they are 13 gold short of a
 * counter"). That is not skill.
 */

/** How a datum may be reached. */
export type VisibilityScope =
  /** The seat's own state. Always fully known. */
  | "own"
  /** Deliberately broadcast to every player and rendered for everyone. */
  | "public"
  /** Enemy state that only a legitimate reveal exposes. */
  | "revealed"
  /** The game exposes this to nobody. It must not exist in the observation. */
  | "never";

export interface VisibilityRule {
  /** Dotted field path, for the record and for the hash. */
  readonly field: string;
  readonly scope: VisibilityScope;
  /** Where the authority for this row lives. */
  readonly source: string;
}

/**
 * Statuses that grant a reveal while active.
 *
 * Named by STATUS id rather than by ability id, so the rule is about the effect
 * and not about Air. A second reveal ability applying the same status, or a
 * different status added to this set, works with no other change — including in
 * `knowledge.ts`'s "a reveal is available to cast" check, which asks whether an
 * ability applies one of these rather than whether it is called Bird's Eye View.
 */
export const REVEALING_STATUS_IDS: ReadonlySet<string> = new Set([
  // Air's "Bird's Eye View" (src/data/airAbilities.ts). A plain self-status
  // with no modifiers and no tick effects — its entire mechanical purpose is
  // the reveal, which is why it is worthless to an omniscient controller and
  // meaningful to this one.
  "birdsEyeView",
]);

/**
 * The table. Order is part of the hash, so keep additions at the end of their
 * group.
 */
export const VISIBILITY: readonly VisibilityRule[] = [
  // ── own ────────────────────────────────────────────────────────────────
  { field: "self.hp", scope: "own", source: "own state" },
  { field: "self.shield", scope: "own", source: "own state" },
  { field: "self.currency", scope: "own", source: "own state" },
  { field: "self.income", scope: "own", source: "own state" },
  { field: "self.citizens", scope: "own", source: "own state" },
  { field: "self.repairs", scope: "own", source: "own state" },
  { field: "self.meter", scope: "own", source: "own state" },
  { field: "self.statuses", scope: "own", source: "own state" },
  { field: "self.cooldowns", scope: "own", source: "own state" },
  { field: "self.upgrades", scope: "own", source: "own state" },
  { field: "self.pendingObligation", scope: "own", source: "own state" },

  // ── public ─────────────────────────────────────────────────────────────
  { field: "enemy.eliminated", scope: "public", source: "KingdomSite.tsx — 'ELIMINATED' is drawn on the dead" },
  { field: "enemy.kingdomId", scope: "public", source: "lobby kingdom selection" },
  { field: "enemy.target", scope: "public", source: "BattlefieldView.tsx — targeting arrows and besiegedStacks" },
  { field: "enemy.statuses", scope: "public", source: "KingdomSite.tsx — per-status overlays render for every kingdom" },
  { field: "field.tick", scope: "public", source: "state:sync — match timer" },
  { field: "field.volcano", scope: "public", source: "gameSync.ts — broadcast to everyone deliberately" },
  { field: "field.caprice", scope: "public", source: "gameSync.ts — broadcast to everyone deliberately" },
  { field: "field.centrepiece", scope: "public", source: "gameSync.ts — sent so clients can grey out ultimates" },

  // ── revealed ───────────────────────────────────────────────────────────
  { field: "enemy.hp", scope: "revealed", source: "BattlefieldView.tsx:470 showStats → KingdomSite.tsx:188 HealthBar" },
  { field: "enemy.shield", scope: "revealed", source: "BattlefieldView.tsx:470 showStats → KingdomSite.tsx:188 ShieldBar" },
  { field: "enemy.citizens", scope: "revealed", source: "BattlefieldView.tsx:470 showStats → KingdomSite.tsx:277 CitizenDisplay" },
  { field: "enemy.income", scope: "revealed", source: "BattlefieldView.tsx:470 showStats → KingdomSite.tsx:277 IncomeDisplay" },

  // ── never ──────────────────────────────────────────────────────────────
  // These have no observation slot at all. They are listed so that the absence
  // is a recorded decision rather than an oversight, and so a future reader can
  // see that the question was asked.
  { field: "enemy.currency", scope: "never", source: "no UI surface renders enemy gold, including under a reveal" },
  { field: "enemy.cooldowns", scope: "never", source: "no UI surface renders enemy cooldowns" },
  { field: "enemy.upgrades", scope: "never", source: "no UI surface renders enemy upgrade levels" },
  { field: "enemy.unlocked", scope: "never", source: "no UI surface renders which abilities an enemy owns" },
  { field: "enemy.meter", scope: "never", source: "no UI surface renders an enemy's charge meters" },
  { field: "enemy.modifiers", scope: "never", source: "modifiers are internal; only their statuses are drawn" },
  { field: "enemy.attackJournal", scope: "never", source: "server-only bookkeeping" },
];

/** Fields the observation is forbidden to contain, for the boundary tests. */
export const FORBIDDEN_FIELDS: readonly string[] = VISIBILITY.filter(
  (r) => r.scope === "never",
).map((r) => r.field);

/**
 * Fingerprint of the table.
 *
 * Pinned against `OBSERVATION_VERSION` by a test: widening what a seat may see
 * changes this, which fails that test, which forces a version bump. That is the
 * whole mechanism — it turns "remember to bump the version" into something the
 * suite enforces.
 *
 * FNV-1a rather than `rng.hashSeed`, so this module stays free of dependencies
 * and the boundary test can assert it imports nothing.
 */
export function visibilitySpecHash(): string {
  const text = [
    ...VISIBILITY.map((r) => `${r.field}:${r.scope}`),
    `revealing=${[...REVEALING_STATUS_IDS].sort().join(",")}`,
  ].join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
