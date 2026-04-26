import { cp, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const src = "config/shell-integration";
const dst = "dist-electron/config/shell-integration";
await mkdir(dirname(dst), { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`copied ${src} -> ${dst}`);
