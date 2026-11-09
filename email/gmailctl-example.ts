/**
 * Example gmailctl config. Real configs are private and live outside this
 * repo; see README.md in this directory.
 *
 * Try it without Gmail access:
 *   bun run email/gmailctl.ts email/gmailctl-example.ts /tmp/gx/config.jsonnet
 *   gmailctl --config /tmp/gx test
 */
import {
  anyFrom,
  anyOf,
  anyTo,
  labelRule,
  type GmailctlConfig,
} from "./gmailctl.ts";

/** Shared work inboxes whose mail is finance, legal, or operations. */
const opsInboxes = ["ops@example.com", "accounting@example.com"];

/** Vendors whose mail is always operational. */
const opsVendors = ["billing.example.net"];

const config: GmailctlConfig = {
  version: "v1alpha3",
  author: { name: "Example", email: "me@example.com" },
  labels: [{ name: "ops-work" }],
  rules: [labelRule("ops-work", anyOf(anyTo(opsInboxes), anyFrom(opsVendors)))],
  tests: [
    {
      name: "Billing mail gets ops-work",
      messages: [{ from: "no-reply@billing.example.net" }],
      actions: { labels: ["ops-work"] },
    },
    {
      name: "Unrelated mail is untouched",
      messages: [{ from: "news@example.org" }],
      actions: {},
    },
  ],
};

export default config;
