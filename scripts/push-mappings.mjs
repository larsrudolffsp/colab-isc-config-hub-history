// ---------------------------------------------------------------------------
// Push Object Mappings to Config Hub
//
// Reads the source and target tenant vars files, tokenizes the source backup
// to discover which JSON paths carry environment-specific values, computes the
// before/after pairs, and registers them as Config Hub Object Mappings via the
// bulk-create API.
//
// After this runs, Config Hub will automatically apply the substitutions when
// a draft is created from an uploaded backup — no need to pre-process the
// backup JSON manually for reference-type fields.
//
// Usage:
//   node --env-file=.env scripts/push-mappings.mjs \
//     --source <sourceTenant> [--target <targetTenant>] [--source-org <org>]
//
//   --source <tenant>    Source tenant whose backup values are mapped FROM.
//                        Reads backups/<tenant>/ to discover tokenizable paths.
//   --target <tenant>    Tenant whose vars provide the TO values. Defaults to
//                        the tenant derived from TENANT_URL in .env.
//   --source-org <org>   The :sourceOrg path segment for the Config Hub API.
//                        Defaults to "default" (org-independent mappings).
//                        Only pass a specific org name when a Config Hub
//                        org-to-org connection already exists.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";
import {
  API_VERSION,
  TENANT_NAME,
  authenticate,
  apiCall,
} from "./common.mjs";
import { tokenizeObject, getTokenPaths, parseVarsYaml } from "./token-utils.mjs";

// Config Hub bulk-create limit per request
const BULK_BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let sourceTenant = null;
  let targetTenant = null;
  let sourceOrg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) sourceTenant = args[++i];
    else if (args[i] === "--target" && args[i + 1]) targetTenant = args[++i];
    else if (args[i] === "--source-org" && args[i + 1]) sourceOrg = args[++i];
  }

  return { sourceTenant, targetTenant, sourceOrg };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an internal path array (["object", "owner", "id"]) to the JSON path
 * format used by Config Hub's Object Mapping API ("$.owner.id").
 * The leading "object" envelope wrapper is stripped.
 */
function pathToJsonPath(pathArr) {
  const segments = pathArr[0] === "object" ? pathArr.slice(1) : pathArr;
  let result = "$";
  for (const seg of segments) {
    result += typeof seg === "number" ? `[${seg}]` : `.${seg}`;
  }
  return result;
}

/**
 * Read all backup JSON files from backups/<tenant>/ and return parsed objects.
 */
function readBackups(tenant) {
  const backupDir = join("backups", tenant);
  if (!existsSync(backupDir)) {
    throw new Error(`Backup directory not found: ${backupDir}`);
  }

  const objects = [];
  const typeDirs = readdirSync(backupDir).filter((d) =>
    statSync(join(backupDir, d)).isDirectory()
  );

  for (const objectType of typeDirs) {
    const typeDir = join(backupDir, objectType);
    for (const file of readdirSync(typeDir).filter((f) => f.endsWith(".json"))) {
      try {
        const parsed = JSON.parse(readFileSync(join(typeDir, file), "utf-8"));
        objects.push({ objectType, content: parsed });
      } catch {
        console.warn(`  Warning: could not parse ${objectType}/${file}, skipping`);
      }
    }
  }

  return objects;
}

/**
 * Load a vars YAML file, erroring with a helpful message if absent.
 */
function loadVarsFile(tenant) {
  const varsPath = join("vars", `${tenant}.vars.yaml`);
  if (!existsSync(varsPath)) {
    throw new Error(
      `Vars file not found: ${varsPath}\n` +
        `Run: node scripts/tokenize.mjs seed-vars ${tenant}`
    );
  }
  const vars = parseVarsYaml(readFileSync(varsPath, "utf-8"));
  console.log(`Loaded ${Object.keys(vars).length} token(s) from ${varsPath}`);
  return vars;
}

// ---------------------------------------------------------------------------
// Config Hub API calls
// ---------------------------------------------------------------------------

/**
 * Retrieve all existing object mappings for a sourceOrg from Config Hub.
 * Returns an empty array if the call fails (e.g. none exist yet).
 */
async function fetchExistingMappings(sourceOrg) {
  try {
    const data = await apiCall(
      "GET",
      `/${API_VERSION}/configuration-hub/object-mappings/${encodeURIComponent(sourceOrg)}`
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Push a single batch (≤ BULK_BATCH_SIZE) of mappings to Config Hub.
 */
async function pushBatch(sourceOrg, batch) {
  return apiCall(
    "POST",
    `/${API_VERSION}/configuration-hub/object-mappings/${encodeURIComponent(sourceOrg)}/bulk-create`,
    { newObjectsMappings: batch }
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const {
    sourceTenant,
    targetTenant: explicitTarget,
    sourceOrg: explicitSourceOrg,
  } = parseArgs();

  if (!sourceTenant) {
    console.error(
      "Usage: node --env-file=.env scripts/push-mappings.mjs --source <sourceTenant> [options]"
    );
    console.error("");
    console.error("Options:");
    console.error(
      "  --source <tenant>      Tenant whose backup values will be mapped FROM"
    );
    console.error(
      "  --target <tenant>      Tenant whose vars provide the TO values"
    );
    console.error(
      "                         (default: tenant from TENANT_URL in .env)"
    );
    console.error(
      '  --source-org <org>     :sourceOrg for the Config Hub API (default: "default")'
    );
    console.error(
      "                         Only needed when a Config Hub org-to-org connection exists"
    );
    console.error("");
    console.error("Examples:");
    console.error(
      "  # Push org-independent mappings (default) — works for any backup origin"
    );
    console.error(
      "  node --env-file=.env scripts/push-mappings.mjs --source beta-15156 --target production"
    );
    console.error("");
    console.error(
      "  # Push mappings tied to a specific org connection (must exist in Config Hub)"
    );
    console.error(
      "  node --env-file=.env scripts/push-mappings.mjs --source beta-15156 --source-org beta-15156"
    );
    process.exit(1);
  }

  const targetTenant = explicitTarget || TENANT_NAME;
  const sourceOrg = explicitSourceOrg ?? "default";

  console.log("=== Push Object Mappings to Config Hub ===");
  console.log(`Source tenant:  ${sourceTenant}  (reads backups/${sourceTenant}/)`);
  console.log(
    `Target tenant:  ${targetTenant}  (reads vars/${targetTenant}.vars.yaml)`
  );
  console.log(`Config Hub org: ${sourceOrg}`);
  console.log();

  // Load vars for both tenants
  const sourceVars = loadVarsFile(sourceTenant);
  const targetVars = loadVarsFile(targetTenant);
  console.log();

  // Walk the source backup to discover objectType + jsonPath for each token
  const sourceObjects = readBackups(sourceTenant);
  console.log(`Read ${sourceObjects.length} object(s) from backups/${sourceTenant}/`);
  console.log();

  // Build mapping entries, deduplicated by "type|jsonPath|sourceValue"
  const mappingMap = new Map();
  let skippedArray = 0;
  let skippedSameValue = 0;
  let skippedNoTarget = 0;

  for (const { content } of sourceObjects) {
    const objectType = content?.self?.type;
    if (!objectType) continue;

    const tokenPaths = getTokenPaths(content);

    for (const { path, tokenName } of tokenPaths) {
      const sourceValue = sourceVars[tokenName];
      const targetValue = targetVars[tokenName];

      if (targetValue === undefined) {
        skippedNoTarget++;
        continue;
      }
      // Config Hub mappings are scalar — arrays need inline substitution
      if (Array.isArray(sourceValue) || Array.isArray(targetValue)) {
        skippedArray++;
        continue;
      }
      if (String(sourceValue) === String(targetValue)) {
        skippedSameValue++;
        continue;
      }

      const jsonPath = pathToJsonPath(path);
      const key = `${objectType}|${jsonPath}|${sourceValue}`;

      if (!mappingMap.has(key)) {
        mappingMap.set(key, {
          objectType,
          jsonPath,
          sourceValue: String(sourceValue),
          targetValue: String(targetValue),
          enabled: true,
        });
      }
    }
  }

  const allMappings = [...mappingMap.values()];
  console.log(`Built ${allMappings.length} unique mapping(s)`);
  if (skippedSameValue > 0) {
    console.log(`  ${skippedSameValue} skipped — source and target values are identical`);
  }
  if (skippedNoTarget > 0) {
    console.log(`  ${skippedNoTarget} skipped — no matching token in target vars`);
  }
  if (skippedArray > 0) {
    console.log(`  ${skippedArray} skipped — array-valued tokens (use --vars at restore time for these)`);
  }

  if (allMappings.length === 0) {
    console.log("\nNothing to push.");
    return;
  }

  // Authenticate against the target tenant
  await authenticate();
  console.log();

  // Fetch existing mappings so we don't create duplicates
  console.log(`Fetching existing mappings for org "${sourceOrg}"...`);
  const existing = await fetchExistingMappings(sourceOrg);
  const existingKeys = new Set(
    existing.map((m) => `${m.objectType}|${m.jsonPath}|${m.sourceValue}`)
  );
  console.log(`  ${existing.length} existing mapping(s) found`);

  const toCreate = allMappings.filter(
    (m) => !existingKeys.has(`${m.objectType}|${m.jsonPath}|${m.sourceValue}`)
  );
  const alreadyPresent = allMappings.length - toCreate.length;
  if (alreadyPresent > 0) {
    console.log(`  ${alreadyPresent} already present — skipping`);
  }

  if (toCreate.length === 0) {
    console.log("\nAll mappings already exist in Config Hub — nothing to push.");
    return;
  }

  // Push in batches of BULK_BATCH_SIZE
  console.log(
    `\nPushing ${toCreate.length} new mapping(s) in batches of ${BULK_BATCH_SIZE}...`
  );
  let pushed = 0;
  for (let i = 0; i < toCreate.length; i += BULK_BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BULK_BATCH_SIZE);
    await pushBatch(sourceOrg, batch);
    pushed += batch.length;
    console.log(`  Pushed ${pushed}/${toCreate.length}`);
  }

  console.log();
  console.log("=== Done! ===");
  console.log(
    `${toCreate.length} mapping(s) registered in Config Hub for org "${sourceOrg}".`
  );
  console.log(
    "Config Hub will apply these automatically when creating a draft from an uploaded backup."
  );
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
