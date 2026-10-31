import { restoreGatewayBackup } from "../server/restore-backup";

const arguments_ = process.argv.slice(2);
const option = (name: string) => arguments_.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const snapshot = option("snapshot"), destination = option("destination");
if (!snapshot || !destination || arguments_.some((argument) => !/^--(?:snapshot|destination)=.+/.test(argument))) {
  console.error("Usage: bun scripts/restore-gateway-backup.ts --snapshot=<snapshot-directory> --destination=<new-or-empty-DATA_DIR>");
  process.exit(2);
}
try {
  const restored = restoreGatewayBackup(snapshot, destination);
  console.log(JSON.stringify({ ...restored, message: "Restore verified. Set DATA_DIR to destination and INDIRECT_SECRET_FILE to secretFile before starting the gateway. No credentials were printed. Daemon data, if included, remains in daemon/ for a separate offline restore." }));
} catch (error) {
  console.error("Restore failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
}
