export type BrandConfig = {
  productName: string;
  cliDisplayName: string;
};

export function loadBrandConfig(): BrandConfig {
  return { productName: "Nova", cliDisplayName: "nova" };
}
