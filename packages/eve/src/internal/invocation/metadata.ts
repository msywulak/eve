import type { RunInput } from "#channel/types.js";

export const INVOCATION_KIND_ATTRIBUTE = "$eve.invocation";
export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";

export const INVOCATION_KIND = "agent";

export type ExternalInvocationMetadata = NonNullable<RunInput["externalInvocation"]>;

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_KIND_ATTRIBUTE]: INVOCATION_KIND,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
