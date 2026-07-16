# Raven update privacy and consent

Managed alpha updates require explicit acceptance of consent contract `closed-alpha-2026-07-12`. Declining leaves managed alpha discovery and delivery disabled without affecting local Raven data.

## Required delivery data

Raven explains and requires acceptance for:

- current Raven semantic version;
- platform and architecture;
- selected channel;
- named cohort eligibility;
- a digest derived from the random local installation identifier and its stable rollout bucket;
- protocol version and advertised capabilities;
- request timestamp;
- network address inherently visible to the API and Arvan edge.

The installation identifier is random, local, and separate from the Raven account. Operations views use aggregate buckets and do not expose the identifier. Request logs are not converted into account-linked analytics.

## Optional aggregate outcomes

A separate opt-in controls coarse check, download, verification, and installation outcomes; previous and resulting versions; platform; architecture; and coarse error category. The backend deduplicates outcome event identifiers for 30 days. It does not collect account identity, relationships, Nest activity, media history, or hardware fingerprints.

## Optional detailed diagnostics

Detailed sharing is off by default and has a separate control. The user can inspect the redacted report before sending it. Accepted reports expire after 14 days.

Redaction removes tokens, cookies, authorization headers, S3 and database credentials, account identifiers, unnecessary IP addresses, LiveKit secrets, and unnecessary home-directory or username paths. Local diagnostics remain available when sharing is disabled.

## Origin and edge logging

Raven nginx logs contain the time, coarse request URI, status, response size, user agent, and network address inherently visible to the origin. Headers and request bodies are not logged. The tokenized download-grant route has nginx access logging disabled so opaque grant query strings are not written to the origin access log.

Raven-specific access logs rotate daily and are deleted after seven days using `infra/homelab/prune-raven-logs.sh`. ArvanCloud may process edge network data under the infrastructure account's retention policy; Raven must disclose that boundary during enrollment and review the provider setting before public production.

Withdrawing optional consent stops new submissions. Existing detailed reports expire under the 14-day rule; aggregate deduplication keys expire under the 30-day rule. Required delivery requests stop when managed alpha consent is withdrawn.

