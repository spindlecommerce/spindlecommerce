/**
 * The platform's plugin API. Plugins peer-depend on it so there is one copy of its exports: checkout
 * catches the same PaymentDeclinedError a plugin throws. `pnpm sdk:package` builds the npm release
 * from the same source; its major version is the plugin API version.
 */
export * from "../../src/plugins/sdk.ts";
