export declare const CANONICAL_HOST: string;
export declare function hostNameOf(hostHeader: string | undefined): string;
export declare function canonicalRedirect(
  hostHeader: string | undefined,
  requestUrl: string | undefined,
  port: number,
): string | null;
