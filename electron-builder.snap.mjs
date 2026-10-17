import { readFileSync } from "node:fs";
import { URL } from "node:url";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const build = packageJson.build ?? {};

export default {
  ...build,
  productName: "strIDEterm",
  linux: {
    ...build.linux,
    target: [{ target: "snap", arch: ["x64"] }],
    category: "Development",
    icon: "assets/icon.png",
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  },
  snap: {
    title: "strIDEterm",
    confinement: "classic",
    grade: "stable",
    artifactName: "strideterm-${version}-${arch}.${ext}",
    summary: "Multi-workspace terminal with Git, Docker, AI agents, and remote access",
    description:
      "Organize shells, AI coding agents, code reviews, Docker, and Git into focused workspaces you can access from anywhere. Includes terminal tabs, Git worktrees, Azure DevOps and GitHub pull request reviews, Docker management, SSH, plugins, and LAN or Cloudflare remote access. This app runs host commands and requires classic confinement.",
  },
};
