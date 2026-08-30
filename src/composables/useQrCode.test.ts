import { ref } from "vue";
import { beforeEach, describe, expect, test, vi } from "vitest";

const toDataURL = vi.hoisted(() => vi.fn(async () => "data:image/png;base64,qr"));

vi.mock("qrcode", () => ({
  default: { toDataURL },
}));

import { useQrCode } from "./useQrCode.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("useQrCode", () => {
  beforeEach(() => {
    toDataURL.mockClear();
  });

  test("uses the requested pixels-per-module scale", async () => {
    const target = ref("strideterm://pair/example");

    const { qrDataUrl } = useQrCode(target, { dark: "#000000", light: "#ffffff" }, 4);
    await flush();

    expect(toDataURL).toHaveBeenCalledWith(
      target.value,
      expect.objectContaining({
        scale: 4,
        margin: 1,
      }),
    );
    expect(qrDataUrl.value).toBe("data:image/png;base64,qr");
  });
});
