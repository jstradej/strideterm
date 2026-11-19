import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { releaseBuild } from "../electron-builder.release.mjs";

const { version, manifest } = releaseBuild();
const release = "release";
const files = await readdir(release);
const manifests = files.filter((file) => file.startsWith("latest") && /\.ya?ml$/.test(file));

if (!manifest) {
  if (manifests.length)
    throw new Error(`Unexpected update manifest(s) in build without a feed: ${manifests.join(", ")}`);
} else {
  if (manifests.length !== 1 || manifests[0] !== manifest) {
    throw new Error(`Expected only ${manifest} in the release output. Found ${manifests.join(", ") || "none"}.`);
  }

  const info = yaml.load(await readFile(path.join(release, manifest), "utf8"));
  if (info?.version !== version || !Array.isArray(info.files) || info.files.length === 0) {
    throw new Error(`Invalid version or artifact list in ${manifest}.`);
  }
  const urls = info.files.map(({ url }) => url);
  const required =
    manifest === "latest.yml"
      ? [`strIDEterm-Setup-${version}.exe`]
      : manifest === "latest-linux.yml"
        ? [`strIDEterm-${version}.AppImage`]
        : [`strIDEterm-${version}-mac-arm64.zip`, `strIDEterm-${version}-mac-x64.zip`];
  const allowed = new Set(
    manifest === "latest-mac.yml"
      ? [...required, `strIDEterm-${version}-mac-arm64.dmg`, `strIDEterm-${version}-mac-x64.dmg`]
      : required,
  );
  if (required.some((asset) => !urls.includes(asset)) || urls.some((asset) => !allowed.has(asset))) {
    throw new Error(`Unexpected update artifacts in ${manifest}: ${urls.join(", ")}`);
  }
  for (const { url, sha512 } of info.files) {
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(path.join(release, url))) hash.update(chunk);
    if (hash.digest("base64") !== sha512) throw new Error(`Update checksum mismatch for ${url}.`);
  }
  if (manifest === "latest.yml") {
    const config = yaml.load(await readFile(path.join(release, "win-unpacked", "resources", "app-update.yml"), "utf8"));
    const publishers = Array.isArray(config?.publisherName) ? config.publisherName : [config?.publisherName];
    if (!publishers.length || publishers.some((publisher) => typeof publisher !== "string" || !publisher.trim())) {
      throw new Error("The Windows update feed must specify an Authenticode publisher.");
    }
  }
  console.info(`Verified ${manifest} and its update artifacts.`);
}
