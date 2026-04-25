declare global {
  interface StridetermAPI {
    [key: string]: unknown;
  }
  interface Window {
    strideterm: StridetermAPI;
  }
}

export {};
