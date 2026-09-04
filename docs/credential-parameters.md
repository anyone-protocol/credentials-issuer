# Credential parameters: decisions we owe ourselves

The scope leaves `k`, blob sizes and epoch length symbolic, to "bind in config when the 0.3 spec
lands". There is no 0.3 spec to wait for — it was a forward reference to work we had not done. So
these are not inputs from elsewhere; they are five decisions we have to make, and this page is where
they get made.

Everything below runs today on a **placeholder**. The placeholders are internally consistent and all
the tests are green against them, which is exactly why they need deciding on purpose rather than by
default: nothing will fail to remind us.

Ordered by deadline, not importance. A decision gets expensive at the moment someone else builds
against it.

---

## 1. `k` and the price of a bundle

**Deadline: before TOON's proxy ships.** Their claim carries an amount that must match ours, and the
price only means something alongside what a bundle contains.

**Placeholder:** `BUNDLE_SIZE=10`, `BUNDLE_PRICE=1.00`.

I3 fixes this as one denomination and one bundle size, so this is a single decision: what does one
purchase cost, and what does it yield.

What depends on it:

- **How often a buyer returns.** Each purchase is a payment event that can be correlated with an
  issuance in time. Fewer, larger purchases mean fewer such events.
- **Blast radius of a leaked bundle.** Everything bought together is compromised together.
- **Request cost.** Signing is linear in `k`. At the measured ~2700 sig/sec a `k=10` bundle is
  12–29 ms, so `k=100` would be ~120–290 ms per request. Not a wall, but it moves.

**What we cannot answer without a usage model:** how many credentials a typical session consumes.
`k` should cover a normal usage period, so buyers are not returning constantly, and that number
comes from the spend side, not from here.

**Cost to change later:** config on both sides. Cheap, until a price is published.

---

## 2. Epoch length and grace window

**Deadline: before the sandbox runs unattended.** Rotation is operator-driven today; nothing rotates
by itself, and an expired keyring fails in a quiet way (see the README).

**Placeholder:** 30-day epochs, 24-hour grace, from `bun run keys:dev`.

The tension worth naming: **all credentials signed under one epoch key are mutually unlinkable, and
credentials under different epoch keys are not.** The epoch is the anonymity set. A short epoch
fragments it; a long epoch enlarges it but leaves a compromised key useful for longer.

Grace is a separate, easier question: it must exceed the longest plausible buy flow, so a buyer who
read the key document just before a rotation is not stranded mid-purchase. A day is generous for an
HTTP flow, and cheap.

**Also undecided:** whether a credential is redeemable after its epoch stops being signable. Issuance
and redemption windows do not have to be the same window, and the redemption service does not exist
yet to have an opinion.

**Cost to change later:** the keyring is regenerated on rotation anyway, so changing the length is
nearly free — but shortening an epoch retroactively fragments an anonymity set that already exists.

---

## 3. Serial format

**Deadline: before anyone writes a wallet.**

**Placeholder:** 32 random bytes, no structure, chosen by the buyer in the harness.

The issuer has no say here and cannot get one: I2 means it never sees an unblinded serial. This is a
contract between the wallet that mints it and the exit that redeems it. It reaches us only as a
length.

The decision is whether the serial carries structure — a version byte, an epoch tag — or is opaque
random bytes. **Any structure is a fingerprint** unless every credential carries identical structure,
and a version byte partitions the anonymity set by wallet version. An exit that needs to know which
epoch key to verify under should be told in the redemption message, not by reading the serial.

**Recommendation:** 32 opaque random bytes; carry the epoch alongside, not inside.

**Cost to change later:** free today, and effectively impossible once wallets are minting them.

---

## 4. Key document schema

**Deadline: before TOON or a wallet parses `/v1/keys/current`.**

**Placeholder:** `{epoch_id, not_before, not_after, alg, pubkey, root_sig}`, `pubkey` as base64
SPKI, timestamps as ISO 8601, `root_sig` an Ed25519 signature over the canonical document
(alphabetical keys, `root_sig` itself excluded).

An M0.1 scenario asserts the response "matches the 0.3 consensus-publication schema". That scenario
is currently **green against a document only we defined**, which is worth being honest about: it
tests self-consistency, not conformance.

The substantive question is not the field names. It is **what `root_sig` becomes.** It stands in for
dirauth consensus signing, and if real consensus signing is N-of-M, the field becomes a collection
and verification changes shape. Deciding that now costs a schema revision; deciding it after wallets
ship costs a migration on every client.

Second question: does the endpoint publish one epoch or several? We hold a keyring of every usable
epoch and publish only the current one. A buyer is unaffected -- they read the document before
blinding and keep it -- but **nothing can fetch a past epoch's public key**, and verifying a
credential is exactly what needs one. An exit redeeming a credential signed under epoch `e`, after
we have rotated to `e+1`, has no endpoint to ask. Whether that is our problem depends on where
consensus publication ends up, which is the same question as `root_sig`.

**Cost to change later:** code here, plus every client that parsed the old shape.

---

## 5. RSA modulus size

**Deadline: before mainnet.** Least urgent: it is a config-and-regenerate change, and the sandbox
does not care.

**Placeholder:** RSA-2048, giving 256-byte blanks and 256-byte blobs.

Trade: 3072 or 4096 buys security margin at 384 or 512 bytes per credential and materially slower
signing (the raw operation grows faster than linearly in modulus bits). The usual "2048 is fine
until ~2030" guidance is about long-lived keys; epoch keys live weeks, which argues for 2048.

That argument only holds if a credential's unforgeability does not have to outlast its epoch — which
is decision 2's open question, so these two settle together.

**Cost to change later:** `BLANK_SIZE_BYTES` and `SIGNATURE_SIZE_BYTES`, one hardcoded
`modulusLength` in [scripts/rotate-epoch.ts](../scripts/rotate-epoch.ts), regenerated test vectors,
and a re-measured signing budget.

---

## What is already decided, and should not be reopened here

- **Suite:** RSABSSA-SHA384-PSS-Randomized, fixed by I1.
- **One denomination, fixed bundles:** I3. `k` is a number to choose, not a range to support.
- **Missed entitlement drips are forfeited**, not accumulated (2026-09-04). See the README.
