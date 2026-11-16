import type { RegistryConnection } from "../../shared/registry.js";

/**
 * The files that point a build tool in the sandbox at the host gateway instead of the private
 * registry. They never hold a credential: the gateway adds the sign-in on the host. Everything here
 * is generated per launch OUTSIDE the workspace tree.
 */

export interface GatewayRegistryEndpoint {
  connection: RegistryConnection;
  /** `http://<gateway host>/registry/<capability>/<connection id>`, no trailing slash. */
  url: string;
}

function xml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-");
}

/**
 * Maven `settings.xml` for the sandbox. The proxy block reads the sandbox proxy from the environment
 * the launcher exports (`STRIDETERM_SANDBOX_PROXY_HOST` / `_PORT` / `_USER` / `_PASS`), because the
 * proxy's credential is only known once the sandbox is up. Settings interpolate `${env.*}` in text fields, but
 * Maven parses `<port>` as a number BEFORE interpolating, so the port is a placeholder the launcher replaces
 * (SANDBOX_PROXY_PORT_PLACEHOLDER) once the sandbox proxy is listening.
 */
export const SANDBOX_PROXY_PORT_PLACEHOLDER = "@@STRIDETERM_SANDBOX_PROXY_PORT@@";

export function buildMavenSettings(endpoints: GatewayRegistryEndpoint[]): string {
  const maven = endpoints.filter((endpoint) => endpoint.connection.kind === "maven");
  const mirrors = maven
    .filter((endpoint) => endpoint.connection.mode === "mirror")
    .map(
      (endpoint) => `    <mirror>
      <id>strideterm-${xml(safeId(endpoint.connection.id))}</id>
      <name>${xml(endpoint.connection.label)}</name>
      <url>${xml(endpoint.url)}</url>
      <mirrorOf>*</mirrorOf>
    </mirror>`,
    );
  const additional = maven.filter((endpoint) => endpoint.connection.mode === "additional");
  const repositories = additional
    .map(
      (endpoint) => `        <repository>
          <id>strideterm-${xml(safeId(endpoint.connection.id))}</id>
          <url>${xml(endpoint.url)}</url>
        </repository>`,
    )
    .join("\n");
  const pluginRepositories = additional
    .map(
      (endpoint) => `        <pluginRepository>
          <id>strideterm-${xml(safeId(endpoint.connection.id))}</id>
          <url>${xml(endpoint.url)}</url>
        </pluginRepository>`,
    )
    .join("\n");
  const profile = additional.length
    ? `  <profiles>
    <profile>
      <id>strideterm-registries</id>
      <repositories>
${repositories}
      </repositories>
      <pluginRepositories>
${pluginRepositories}
      </pluginRepositories>
    </profile>
  </profiles>
  <activeProfiles>
    <activeProfile>strideterm-registries</activeProfile>
  </activeProfiles>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">
  <proxies>
    <proxy>
      <id>strideterm-sandbox</id>
      <active>true</active>
      <protocol>http</protocol>
      <host>\${env.STRIDETERM_SANDBOX_PROXY_HOST}</host>
      <port>${SANDBOX_PROXY_PORT_PLACEHOLDER}</port>
      <username>\${env.STRIDETERM_SANDBOX_PROXY_USER}</username>
      <password>\${env.STRIDETERM_SANDBOX_PROXY_PASS}</password>
      <nonProxyHosts>localhost|127.0.0.1</nonProxyHosts>
    </proxy>
  </proxies>
${mirrors.length ? `  <mirrors>\n${mirrors.join("\n")}\n  </mirrors>\n` : ""}${profile}</settings>
`;
}

/** The Maven options that use the generated settings and the transport that works through the proxy. */
export function mavenArgs(settingsPath: string, localRepository: string): string {
  const quote = (value: string) => `"${value.replace(/(["\\$`])/gu, "\\$1")}"`;
  return `-s ${quote(settingsPath)} -Dmaven.repo.local=${quote(localRepository)} -Dmaven.resolver.transport=wagon`;
}

/** `.npmrc` for the sandbox: the registry (or one scope of it) points at the gateway; no `_authToken`. */
export function buildNpmrc(endpoints: GatewayRegistryEndpoint[]): string {
  const lines: string[] = [];
  for (const { connection, url } of endpoints) {
    if (connection.kind !== "npm") continue;
    const target = `${url}/`;
    if (connection.npmScope) lines.push(`${connection.npmScope}:registry=${target}`);
    else if (connection.mode === "mirror") lines.push(`registry=${target}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** `pip.conf` for the sandbox. */
export function buildPipConf(endpoints: GatewayRegistryEndpoint[]): string {
  const pip = endpoints.filter((endpoint) => endpoint.connection.kind === "pip");
  const mirror = pip.find((endpoint) => endpoint.connection.mode === "mirror");
  const extra = pip.filter((endpoint) => endpoint !== mirror);
  const lines = ["[global]"];
  if (mirror) lines.push(`index-url = ${mirror.url}/simple`);
  if (extra.length) lines.push(`extra-index-url = ${extra.map((endpoint) => `${endpoint.url}/simple`).join(" ")}`);
  lines.push(`trusted-host = ${[...new Set(pip.map((endpoint) => new URL(endpoint.url).hostname))].join(" ")}`);
  return pip.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Gradle init script (`<GRADLE_USER_HOME>/init.d/strideterm.gradle`): adds the gateway endpoints to
 * build and plugin resolution and, for a mirror, replaces the default repositories. The URLs are plain
 * http, so `allowInsecureProtocol` is set — the hop stays inside the sandbox and the host gateway.
 */
export function buildGradleInit(endpoints: GatewayRegistryEndpoint[]): string {
  const gradle = endpoints.filter((endpoint) => endpoint.connection.kind === "gradle");
  if (!gradle.length) return "";
  const repo = (endpoint: GatewayRegistryEndpoint) =>
    `maven { url = uri(${JSON.stringify(endpoint.url)}); allowInsecureProtocol = true }`;
  const mirrorMode = gradle.some((endpoint) => endpoint.connection.mode === "mirror");
  const repoLines = gradle.map(repo).join("\n      ");
  return `// Generated by strIDEterm for this sandbox session. Holds no credentials.
def strideRegistries = { RepositoryHandler handler ->
  ${mirrorMode ? "handler.clear()\n  " : ""}handler.with {
      ${repoLines}
  }
}
beforeSettings { settings ->
  settings.pluginManagement.repositories(strideRegistries)
}
allprojects {
  buildscript.repositories(strideRegistries)
  repositories(strideRegistries)
}
`;
}
