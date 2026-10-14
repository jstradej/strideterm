import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const STORE_APPX_ICON_SPECS = Object.freeze([
  Object.freeze({ name: "StoreLogo.png", width: 50, height: 50 }),
  Object.freeze({ name: "Square44x44Logo.png", width: 44, height: 44 }),
  Object.freeze({ name: "Square150x150Logo.png", width: 150, height: 150 }),
  Object.freeze({ name: "Wide310x150Logo.png", width: 310, height: 150 }),
]);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function validateStoreAppxIcons(directory) {
  let names;
  try {
    names = new Set(await readdir(directory));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Store AppX icons are invalid; refusing electron-builder sample fallback: ${directory} is missing`,
      { cause: error },
    );
  }
  const errors = [];

  for (const { name, width, height } of STORE_APPX_ICON_SPECS) {
    if (!names.has(name)) {
      errors.push(`${name} is missing (expected ${width}x${height})`);
      continue;
    }

    const image = await readFile(path.join(directory, name));
    if (
      image.length < 33 ||
      !image.subarray(0, 8).equals(PNG_SIGNATURE) ||
      image.readUInt32BE(8) !== 13 ||
      image.toString("ascii", 12, 16) !== "IHDR"
    ) {
      errors.push(`${name} is not a valid PNG header`);
      continue;
    }

    const actualWidth = image.readUInt32BE(16);
    const actualHeight = image.readUInt32BE(20);
    if (actualWidth !== width || actualHeight !== height) {
      errors.push(`${name} must be ${width}x${height}; found ${actualWidth}x${actualHeight}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Store AppX icons are invalid; refusing electron-builder sample fallback:\n- ${errors.join("\n- ")}`,
    );
  }
}
