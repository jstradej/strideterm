import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

const { build, version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const feed = { provider: "github", owner: "jstradej", repo: "strideterm", channel: "latest", private: false };

function signingCredentialsPresent(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length === names.length) return false;
  if (missing.length > 0) throw new Error(`Incomplete release signing configuration. Set ${missing.join(", ")}.`);
  return true;
}

export function releaseBuild(platform = process.platform, env = process.env) {
  const config = { ...build, deb: { ...build.deb, publish: null } };
  const stable = /^v\d+\.\d+\.\d+$/.test(env.GITHUB_REF_NAME ?? "");
  if (stable && env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`Release tag ${env.GITHUB_REF_NAME} must match the package version (v${version}).`);
  }

  let manifest;
  if (stable && platform === "linux") {
    config.linux = { ...build.linux, publish: feed };
    manifest = "latest-linux.yml";
  } else if (stable && platform === "win32") {
    if (signingCredentialsPresent(env, ["CSC_LINK", "CSC_KEY_PASSWORD"])) {
      config.forceCodeSigning = true;
      config.win = { ...build.win, publish: feed };
      manifest = "latest.yml";
    }
  } else if (stable && platform === "darwin") {
    if (
      signingCredentialsPresent(env, [
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_TEAM_ID",
      ])
    ) {
      // Remove the ad-hoc identity so electron-builder selects a Developer ID identity.
      const mac = { ...build.mac };
      delete mac.identity;
      const dmg = mac.target.find((target) => target.target === "dmg");
      config.mac = {
        ...mac,
        hardenedRuntime: true,
        notarize: true,
        publish: feed,
        target: [...mac.target, { target: "zip", arch: dmg.arch }],
      };
      config.forceCodeSigning = true;
      manifest = "latest-mac.yml";
    }
  }

  return { config, version, manifest };
}

const release = releaseBuild();
if (!release.manifest) {
  console.info("In-app update feed disabled for this build. Stable Windows and macOS feeds require release signing.");
}
export default release.config;
