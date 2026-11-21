export function absoluteAttachmentPath(workspaceRoot: string, relativePath: string): string {
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const relative = relativePath.replace(/^[\\/]+/, "");
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  return `${root}${separator}${relative.replace(/[\\/]/g, separator)}`;
}
