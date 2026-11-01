import { defineConfig } from "@spindlecommerce/plugin-sdk";
import { shippo } from "@spindlecommerce/plugin-shippo";
import { email } from "./plugins/email/index.ts";
import { stripe } from "./plugins/stripe/index.ts";

/**
 * The plugins this installation runs. To add one, `pnpm add` it if it's published (such as
 * @spindlecommerce/plugin-hello-world), list it here and deploy, then enable and configure it
 * in the admin under Settings › Plugins. See docs/plugins.md.
 */
export default defineConfig({
  plugins: [email(), stripe(), shippo()],
});
