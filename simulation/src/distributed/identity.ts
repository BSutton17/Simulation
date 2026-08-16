import { buildSchema, searchable, type SearchScope } from "../search/index.js";
import { captureProvenance } from "../evaluation/provenance.js";
import { FITNESS_VERSION } from "../fitness/index.js";
import type { ExperimentIdentity } from "./protocol.js";

/**
 * What this build believes it is.
 *
 * Computed the same way by the coordinator and by every worker, so comparing
 * two of them answers "are these the same experiment?" without anyone having to
 * agree a convention. The engine SHA comes from the vendored marker rather than
 * this repository's commit, so a launcher tweak or a doc fix does not make a
 * worker look incompatible.
 */
export function localIdentity(options: {
  scope?: SearchScope;
  seed?: number;
  populationSize?: number;
  sigma?: number;
  weightsName?: string;
} = {}): ExperimentIdentity {
  const scope = options.scope ?? "expanded";
  const schema = buildSchema({ scope });
  const provenance = captureProvenance({
    balanceConfigId: "identity",
    strategyPopulationVersion: "v1",
  });

  return {
    engineSha: provenance.engineSha,
    schemaVersion: schema.version,
    catalogHash: schema.catalogHash,
    seed: options.seed ?? 20260813,
    // Defaults to the CMA-ES standard for this dimensionality, which is what
    // the coordinator uses when nothing is specified.
    populationSize:
      options.populationSize ?? 4 + Math.floor(3 * Math.log(searchable(schema).length)),
    sigma: options.sigma ?? 0.2,
    scope,
    fitnessVersion: FITNESS_VERSION,
    weightsName: options.weightsName ?? "designerPriority",
  };
}
