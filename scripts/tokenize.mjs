// ---------------------------------------------------------------------------
// ISC Configuration Tokenization Tool
//
// Subcommands:
//   seed-vars <tenant>
//       Read backups/<tenant>/, discover all tokenizable field values, and
//       write vars/<tenant>.vars.yaml.  No template files are created.
//
//   find-tokens <targetTenant> --source <sourceTenant>
//       For each object in backups/<sourceTenant>/, find the matching object
//       in backups/<targetTenant>/ by self.name + self.type, extract the
//       environment-specific values at the same tokenizable paths, and write
//       vars/<targetTenant>.vars.yaml.  Warns for any object that exists in
//       the source but has no name-matched counterpart in the target.
//
//   diff-tenants <tenant-a> <tenant-b>
//       Compare two tenants' backups by name+type and report fields that
//       differ — these are token candidates to add to TOKENIZABLE_PATHS.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import {
  tokenizeObject,
  matchBackupByName,
  varsToYaml,
  deepDiff,
} from "./token-utils.mjs";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const positional = [];
  let sourceTenant = null;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      sourceTenant = args[++i];
    } else if (!args[i].startsWith("--")) {
      positional.push(args[i]);
    }
  }

  return { subcommand, positional, sourceTenant };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read all backup JSON files from backups/<tenant>/ and return an array of
 * { objectType, objectId, content } objects.
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
      const objectId = basename(file, ".json");
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(join(typeDir, file), "utf-8"));
      } catch {
        console.warn(`  Warning: could not parse ${objectType}/${file}, skipping`);
        continue;
      }
      objects.push({ objectType, objectId, content: parsed });
    }
  }

  return objects;
}

/**
 * Tokenize all objects in the given array and merge their tokenMaps into a
 * single vars object.  Warns on collisions where the same token name resolves
 * to different values (keeps the first value seen).
 *
 * Returns { mergedVars, tokenizedCount, skippedCount }.
 */
function buildVarsFromObjects(objects) {
  const mergedVars = {};
  let tokenizedCount = 0;
  let skippedCount = 0;

  for (const { content } of objects) {
    const { tokenMap } = tokenizeObject(content);

    if (Object.keys(tokenMap).length === 0) {
      skippedCount++;
      continue;
    }

    for (const [tokenName, value] of Object.entries(tokenMap)) {
      if (
        tokenName in mergedVars &&
        JSON.stringify(mergedVars[tokenName]) !== JSON.stringify(value)
      ) {
        console.warn(
          `  Warning: token collision for ${tokenName} — keeping first value`
        );
      } else {
        mergedVars[tokenName] = value;
      }
    }
    tokenizedCount++;
  }

  return { mergedVars, tokenizedCount, skippedCount };
}

/**
 * Write vars to disk and print a summary line.
 */
function writeVars(tenant, mergedVars) {
  mkdirSync("vars", { recursive: true });
  const varsPath = join("vars", `${tenant}.vars.yaml`);
  writeFileSync(varsPath, varsToYaml(mergedVars, tenant));
  console.log(`Wrote vars/${tenant}.vars.yaml  (${Object.keys(mergedVars).length} token(s))`);
}

// ---------------------------------------------------------------------------
// seed-vars
// ---------------------------------------------------------------------------

function cmdSeedVars(tenant) {
  console.log(`=== seed-vars: backups/${tenant}/ → vars/${tenant}.vars.yaml ===`);
  console.log();

  const objects = readBackups(tenant);
  console.log(`Read ${objects.length} backup file(s) from backups/${tenant}/`);
  console.log();

  const { mergedVars, tokenizedCount, skippedCount } = buildVarsFromObjects(objects);

  if (Object.keys(mergedVars).length === 0) {
    console.log("No tokenizable fields found — vars file not written.");
    return;
  }

  writeVars(tenant, mergedVars);
  console.log();
  console.log(
    `Done: ${tokenizedCount} object(s) contributed tokens, ` +
      `${skippedCount} had no tokenizable fields`
  );
}

// ---------------------------------------------------------------------------
// find-tokens
// ---------------------------------------------------------------------------

function cmdFindTokens(targetTenant, sourceTenant) {
  console.log(
    `=== find-tokens: backups/${sourceTenant}/ → backups/${targetTenant}/ ===`
  );
  console.log();

  const sourceObjects = readBackups(sourceTenant);
  console.log(`Source: ${sourceObjects.length} object(s) in backups/${sourceTenant}/`);

  const targetBackupDir = join("backups", targetTenant);
  if (!existsSync(targetBackupDir)) {
    throw new Error(`Target backup directory not found: ${targetBackupDir}`);
  }

  const mergedVars = {};
  let matchedCount = 0;
  let unmatchedCount = 0;

  for (const { content: sourceContent } of sourceObjects) {
    const name = sourceContent?.self?.name;
    const type = sourceContent?.self?.type;

    if (!name || !type) continue;

    // For LIFECYCLE_STATE, disambiguate same-named states in different profiles
    const profileHint =
      type === "LIFECYCLE_STATE"
        ? sourceContent?.object?.identityProfileRef?.name
        : undefined;

    const match = matchBackupByName(targetBackupDir, type, name, profileHint);
    if (!match) {
      console.warn(
        `  No match in backups/${targetTenant}/ for ${type} "${name}"`
      );
      unmatchedCount++;
      continue;
    }

    // Tokenize the matched target object — since self.name and self.type are
    // the same, the derived token names will be identical to those that would
    // be generated from the source object.
    const { tokenMap } = tokenizeObject(match.parsed);
    const tokenCount = Object.keys(tokenMap).length;

    if (tokenCount > 0) {
      console.log(`  ${type} "${name}"  →  matched  (${tokenCount} token(s))`);
    }

    for (const [tokenName, value] of Object.entries(tokenMap)) {
      if (
        tokenName in mergedVars &&
        JSON.stringify(mergedVars[tokenName]) !== JSON.stringify(value)
      ) {
        console.warn(
          `  Warning: token collision for ${tokenName} — keeping first value`
        );
      } else {
        mergedVars[tokenName] = value;
      }
    }
    matchedCount++;
  }

  console.log();

  if (Object.keys(mergedVars).length === 0) {
    console.log("No tokens were extracted — vars file not written.");
  } else {
    writeVars(targetTenant, mergedVars);
  }

  if (unmatchedCount > 0) {
    console.log();
    console.log(
      `${unmatchedCount} object(s) from backups/${sourceTenant}/ had no name-matched ` +
        `counterpart in backups/${targetTenant}/. ` +
        `Manually add their token values to vars/${targetTenant}.vars.yaml.`
    );
  }

  console.log();
  console.log(`Done: ${matchedCount} matched, ${unmatchedCount} unmatched`);
}

// ---------------------------------------------------------------------------
// diff-tenants
// ---------------------------------------------------------------------------

function cmdDiffTenants(tenantA, tenantB) {
  console.log(`=== diff-tenants: ${tenantA}  vs  ${tenantB} ===`);
  console.log();

  const objectsA = readBackups(tenantA);
  const objectsB = readBackups(tenantB);

  console.log(`${tenantA}: ${objectsA.length} object(s)`);
  console.log(`${tenantB}: ${objectsB.length} object(s)`);
  console.log();

  // Index tenant B by "type::name" for fast lookup
  const indexB = new Map();
  for (const obj of objectsB) {
    const key = `${obj.content?.self?.type}::${obj.content?.self?.name}`;
    indexB.set(key, obj);
  }

  let matchedCount = 0;
  let differentCount = 0;
  let onlyInA = 0;

  for (const objA of objectsA) {
    const nameA = objA.content?.self?.name;
    const typeA = objA.content?.self?.type ?? objA.objectType;
    const key = `${typeA}::${nameA}`;

    const objB = indexB.get(key);
    if (!objB) {
      onlyInA++;
      continue;
    }

    const diffs = deepDiff(objA.content, objB.content);
    if (diffs.length === 0) {
      matchedCount++;
      continue;
    }

    differentCount++;
    console.log(`${typeA}  "${nameA}":`);
    for (const { path, valueA, valueB } of diffs) {
      const pathStr = path.join(".");
      const vA = valueA === undefined ? "(missing)" : JSON.stringify(valueA);
      const vB = valueB === undefined ? "(missing)" : JSON.stringify(valueB);
      console.log(`  ${pathStr}`);
      console.log(`    ${tenantA}: ${vA}`);
      console.log(`    ${tenantB}: ${vB}`);
    }
    console.log();
  }

  // Objects only in tenant B
  let onlyInB = 0;
  for (const objB of objectsB) {
    const nameB = objB.content?.self?.name;
    const typeB = objB.content?.self?.type ?? objB.objectType;
    const key = `${typeB}::${nameB}`;
    if (!objectsA.some((a) => (a.content?.self?.type ?? a.objectType) + "::" + a.content?.self?.name === key)) {
      onlyInB++;
    }
  }

  console.log("--- Summary ---");
  console.log(`  Identical (by name+type):  ${matchedCount}`);
  console.log(`  Different (by name+type):  ${differentCount}`);
  console.log(`  Only in ${tenantA}:  ${onlyInA}`);
  console.log(`  Only in ${tenantB}:  ${onlyInB}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage() {
  console.error("Usage: node scripts/tokenize.mjs <subcommand> [args]");
  console.error("");
  console.error("Subcommands:");
  console.error("");
  console.error("  seed-vars <tenant>");
  console.error("      Scan backups/<tenant>/, extract all environment-specific");
  console.error("      field values, and write vars/<tenant>.vars.yaml.");
  console.error("");
  console.error("  find-tokens <targetTenant> --source <sourceTenant>");
  console.error("      Match each object in backups/<sourceTenant>/ to its");
  console.error("      counterpart in backups/<targetTenant>/ by self.name +");
  console.error("      self.type, extract the target values at every tokenizable");
  console.error("      field, and write vars/<targetTenant>.vars.yaml.");
  console.error("      Warns for objects present in source but absent in target.");
  console.error("");
  console.error("  diff-tenants <tenant-a> <tenant-b>");
  console.error("      Compare two tenants' backups by name+type and print every");
  console.error("      field that differs — useful for discovering token candidates.");
  console.error("");
  console.error("Examples:");
  console.error("  # Seed a vars file from your own backup");
  console.error("  node scripts/tokenize.mjs seed-vars beta-15156");
  console.error("");
  console.error("  # Extract token values for a second tenant using your tenant as the reference");
  console.error("  node scripts/tokenize.mjs find-tokens production --source beta-15156");
  console.error("");
  console.error("  # Discover token candidates between two tenants");
  console.error("  node scripts/tokenize.mjs diff-tenants beta-15156 production");
  console.error("");
  console.error("  # Restore a backup with vars substituted");
  console.error("  node --env-file=.env scripts/restore.mjs local --vars production");
}

const { subcommand, positional, sourceTenant } = parseArgs();

try {
  switch (subcommand) {
    case "seed-vars": {
      const tenant = positional[0];
      if (!tenant) {
        console.error(`Error: ${subcommand} requires a <tenant> argument`);
        printUsage();
        process.exit(1);
      }
      cmdSeedVars(tenant);
      break;
    }

    case "find-tokens": {
      const targetTenant = positional[0];
      if (!targetTenant) {
        console.error("Error: find-tokens requires a <targetTenant> argument");
        printUsage();
        process.exit(1);
      }
      if (!sourceTenant) {
        console.error("Error: find-tokens requires --source <sourceTenant>");
        printUsage();
        process.exit(1);
      }
      cmdFindTokens(targetTenant, sourceTenant);
      break;
    }

    case "diff-tenants": {
      const [tenantA, tenantB] = positional;
      if (!tenantA || !tenantB) {
        console.error("Error: diff-tenants requires two <tenant> arguments");
        printUsage();
        process.exit(1);
      }
      cmdDiffTenants(tenantA, tenantB);
      break;
    }

    default:
      if (subcommand) {
        console.error(`Error: unknown subcommand "${subcommand}"`);
      }
      printUsage();
      process.exit(1);
  }
} catch (err) {
  console.error("FATAL:", err.message || err);
  process.exit(1);
}
