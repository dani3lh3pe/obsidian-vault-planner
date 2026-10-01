// The hand-off to Windows, like entra-pim-manager's Setup.exe: one file to download.
//   release/vault-planner.zip  -> unpack into <vault>/.obsidian/plugins/ (contains vault-planner/)
//   release/test-vault.zip     -> the throwaway vault, unpacked once on the notebook
// Python's zipfile, because the host has no `zip` and Node's stdlib has no archive writer.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// A build id in the version, visible under Settings → Community plugins: testing a stale build
// is the expensive failure of a two-machine loop.
const stamp = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
  .format(new Date())
  .replace(/\D/g, "");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
// A tag build (CI) is a release: the version stays as it is, and the tag must equal it — Obsidian
// looks a plugin's release up by the manifest version.
if (process.env.GITHUB_REF_TYPE === "tag") {
  if (process.env.GITHUB_REF_NAME !== manifest.version) {
    throw new Error(`tag ${process.env.GITHUB_REF_NAME} differs from the manifest version ${manifest.version}`);
  }
} else {
  manifest.version = `${manifest.version}-dev.${stamp}`;
}

rmSync("release", { recursive: true, force: true });
mkdirSync("release/vault-planner", { recursive: true });
cpSync("build/main.js", "release/vault-planner/main.js");
cpSync("styles.css", "release/vault-planner/styles.css");
writeFileSync("release/vault-planner/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

execFileSync("python3", ["-m", "zipfile", "-c", "vault-planner.zip", "vault-planner"], { cwd: "release" });
// The zip's root is the vault root. One level deeper, no path starts with 10_Kunden/ and the task
// list stays empty.
execFileSync("python3", ["-m", "zipfile", "-c", "../release/test-vault.zip", ...readdirSync("test-vault")], {
  cwd: "test-vault",
});

console.log(`release/vault-planner.zip  ${manifest.version}`);
