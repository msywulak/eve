---
issue: "842"
last_updated: "2026-07-21"
status: reproduced
---

# Issue #842 hosted package-tracing diagnosis

## Conclusion

Issue #842 is reproduced on Vercel with registry `eve@0.24.3`. The required trigger is not merely importing `@vercel/connect/eve`: the package must remain external through the agent's `build.externalDependencies`. Once `@vercel/connect` is external, Nitro/nf3 traces its runtime imports into `eve/connections` and `eve/channels/auth`, emits an incomplete `node_modules/eve`, and the deployed function crashes with the exact reported error:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/var/task/node_modules/eve/dist/src/public/connections/errors.js'
imported from /var/task/node_modules/eve/dist/src/public/connections/index.js
```

The issue also remains structurally present in the current checkout: its package import map and hosted tracing setup are unchanged, and a direct nf3 trace emits `connections/index.js` but omits `connections/errors.js`.

## Issue and related work

- #842: hosted service output ships incomplete `node_modules/eve`.
- Linked pull requests for #842: none.
- #839: named multi-agent callback URLs drop their public route prefix.
- #840: proposed fix for #839.
- #841: named same-origin remote-agent create-session URLs drop their base path.

Issues #839–#841 established that the reporter encountered several production failures after a named multi-agent cutover. Their routing bugs are separate from #842, but they identified Next.js `withEve({ agents })` as the production output path worth reproducing.

## Reproduction

The successful reproduction is a Next.js app using registry versions:

```json
{
  "dependencies": {
    "@vercel/connect": "0.2.2",
    "eve": "0.24.3",
    "next": "16.2.6"
  }
}
```

It configures two named services:

```ts
import { withEve } from "eve/next";

export default withEve(
  {},
  {
    agents: {
      research: "./agents/research",
      support: "./agents/support",
    },
  },
);
```

The research agent opts Connect into the external-and-trace path:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  build: { externalDependencies: ["@vercel/connect"] },
  model: "openai/gpt-5.4-mini",
});
```

Its connection uses the ordinary scaffolded integration shape:

```ts
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  auth: connect("linear"),
  description: "Issue 842 multi-agent Vercel Connect tracing reproduction.",
  url: "https://example.com/mcp",
});
```

The support agent has no external dependency and serves as the control. Both agents also import `eve/channels/auth` from their eve channel definitions.

The Vercel project uses the **Next.js** framework preset and default Next.js output settings. This is required for `withEve({ agents })`; the Eve preset is for standalone eve applications.

## Reproduced deployment

- Inspect: `https://vercel.com/vercel-internal-playground/colton-spoke-and-mirror/8CaNS2jHq5Ae4FDqEsB6QBt8Ri3z`
- Preview: `https://colton-spoke-and-mirror-s152hj087.playground-vercel.tools`

The remote source-build log shows that the research service enters dependency tracing:

```text
Tracing dependencies:
- `@vercel/connect` (0.2.2)
- `eve` (0.24.3)
...
Traced 26 dependencies (247 files)
```

The two named services then behave differently:

```text
GET /eve/agents/research/eve/v1/info
  -> FUNCTION_INVOCATION_FAILED

GET /eve/agents/support/eve/v1/health
  -> {"ok":true,"status":"ready",...}
```

Expanded Vercel runtime logs for the research request contain the exact missing-module failure quoted above. The support service remains healthy because it bundles eve and never creates a traced `node_modules/eve` package.

## Local artifact confirmation

Running the same research agent through a local Vercel-mode standalone build produces two inspectable functions. Each contains exactly five eve files:

```text
node_modules/eve/dist/src/compiled/_chunks/workflow/chunk-BHKSVoKr.js
node_modules/eve/dist/src/compiled/jose/index.js
node_modules/eve/dist/src/public/channels/auth.js
node_modules/eve/dist/src/public/connections/index.js
node_modules/eve/package.json
```

Across the application and flow functions there are ten eve files total. Neither contains `dist/src/public/connections/errors.js`. Importing the generated application function directly with Node immediately throws the same `ERR_MODULE_NOT_FOUND`, without involving Vercel routing or a network request. This independently confirms that the defect is in build output packaging rather than deployment routing.

## Root cause

`@vercel/connect/dist/eve/connection-authorization.js` contains a runtime import from `eve/connections`. When Connect is external, Nitro follows that import and starts tracing eve from its public export entry:

```text
node_modules/eve/dist/src/public/connections/index.js
```

That entry uses eve's package-internal imports:

```js
import { ... } from "#public/connections/errors.js";
```

The relevant eve package map is:

```json
{
  "imports": {
    "#*.js": {
      "eve-source": "./src/*.ts",
      "default": "./dist/src/*.js"
    }
  }
}
```

Nitro delegates external-package closure collection to nf3, which vendors `@vercel/nft`. The vendored resolver's import-map wildcard logic recognizes only keys where `*` is the final character. It does not match eve's embedded wildcard key `#*.js`. The trace does not fail the build; it records warnings and continues with a partial package.

A direct nf3 trace reproduces the warning:

```text
Failed to resolve dependency "#public/connections/errors.js":
Cannot find module '#public/connections/errors.ts' loaded from
.../node_modules/eve/dist/src/public/connections/index.js
```

For `eve@0.24.3`, that trace emits only five eve files:

```text
dist/src/compiled/_chunks/workflow/chunk-BHKSVoKr.js
dist/src/compiled/jose/index.js
dist/src/public/channels/auth.js
dist/src/public/connections/index.js
package.json
```

It omits `dist/src/public/connections/errors.js` and the rest of both internal closures. This matches the reporter's description of a package containing only export-map entry files.

## Why the earlier attempts were false negatives

Several progressively closer deployments remained healthy:

1. Standalone `eve build` with `eve/channels/auth`.
2. Remote standalone source build with `eve@0.24.3`.
3. A Connect-authored connection importing both `@vercel/connect/eve` and `eve/connections`.
4. Next.js named multi-agent output containing that same connection.

All four bundled Connect and eve into `_libs/*.mjs`; none exercised nf3's package tracing. Importing Connect is insufficient by itself. The missing condition was:

```ts
build: {
  externalDependencies: ["@vercel/connect"];
}
```

Adding this single field changed the research service from a healthy bundled function to the exact reported traced-package crash. The reporter's statement that eve “traces `build.externalDependencies` into the hosted service output” was therefore the critical reproduction instruction.

## Latest published release

The same application was redeployed unchanged except for upgrading eve to the latest published release, `eve@0.27.0`:

- Inspect: `https://vercel.com/vercel-internal-playground/colton-spoke-and-mirror/468yC6LfFsd8JiWNb7kCejeXmU7F`
- Preview: `https://colton-spoke-and-mirror-djtx6mvvs.playground-vercel.tools`

The remote build again traces `@vercel/connect@0.2.2` and `eve@0.27.0`. The research route returns `FUNCTION_INVOCATION_FAILED`, and expanded runtime logs contain the same missing `dist/src/public/connections/errors.js` error. The non-externalizing support agent remains healthy.

The current checkout also retains the `"#*.js"` package import pattern and the same Nitro/nf3 resolver behavior. A direct trace against its built package emits `connections/index.js`, omits `connections/errors.js`, and reports the same resolution warning.

A fix must therefore be validated against both `eve@0.24.3` and the latest release. The regression test must configure an external package that imports an eve public subpath; a test where that package is bundled will not cover the bug.

## Immediate fix validation

The eve-side mitigation adds Nitro's `eve*` full-trace selector whenever an agent configures `build.externalDependencies`. Ordinary agents without configured externals continue bundling eve and do not pay the full-package trace cost.

A tarball built from the patched checkout was installed into the exact failing multi-agent reproduction and deployed without publishing eve:

- Inspect: `https://vercel.com/vercel-internal-playground/colton-spoke-and-mirror/2gf26aEpWKtpTs9VUCX9t5WMzaAg`
- Preview: `https://colton-spoke-and-mirror-pgs5o2zw5.playground-vercel.tools`

The previously failing research info route now succeeds and reports `connectionName: "connect-repro"`; the support health route remains ready. A local build contains `connections/errors.js` and imports its generated function successfully. The affected application function grows from roughly 4.4 MB to 20.5 MB uncompressed, which is acceptable as an immediate correctness fix but reinforces the need for a precise upstream wildcard-resolution fix.

## Unrelated playground configuration failure

Deployment `dpl_938d8LSb4CXoKV6tTkvxi2CDtYYq` failed with “No Output Directory named `.output`”. Its logs show a normal `next build` followed by a stale `.output` expectation. It contains no eve hosted-service build or module-resolution failure and is unrelated to #842.
