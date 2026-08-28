import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { transformLegacySnapshot } from "./transform.mjs";

export function dryRunSnapshot(snapshot) {
  const report = transformLegacySnapshot(snapshot);
  const migrationId = snapshot?.migrationId ?? snapshot?.migration_id ?? null;
  const freezeAt = snapshot?.freezeAt ?? snapshot?.freeze_at ?? null;
  return { ...report, migrationId, freezeAt };
}

export function redactedDryRunSummary(report) {
  return {
    status: report.conflicts.length === 0 ? "review_ready" : "conflicts_present",
    snapshotId: report.snapshotId,
    snapshotHash: report.snapshotHash,
    importableCount: report.importable.length,
    conflictCount: report.conflicts.length,
    warningCount: report.warnings.length,
    sourceCounts: report.sourceCounts,
    roleCounts: report.roleCounts
  };
}

export async function runDryRun({ snapshotFile, outputFile = null } = {}) {
  if (!snapshotFile) throw new Error("MIGRATION_SNAPSHOT_FILE_REQUIRED");
  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  const report = dryRunSnapshot(snapshot);
  if (outputFile) {
    await writeFile(outputFile, `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  return report;
}

function argumentValue(argv, names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1) return argv[index + 1] || null;
  }
  return null;
}

async function main(argv = process.argv.slice(2)) {
  const snapshotFile = argumentValue(argv, ["--snapshot-file"]);
  if (!snapshotFile) throw new Error("Usage: node dry-run.mjs --snapshot-file <file> [--output <file>]");
  const report = await runDryRun({
    snapshotFile,
    outputFile: argumentValue(argv, ["--output", "--output-file"])
  });
  process.stdout.write(`${JSON.stringify(redactedDryRunSummary(report))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
