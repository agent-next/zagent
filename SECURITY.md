# Security Policy

## Reporting a vulnerability
Please report security issues **privately** via GitHub Security Advisories
("Report a vulnerability" under the Security tab) rather than a public issue.
We aim to acknowledge reports within a few days.

Especially valuable: anything that could leak a user's local credentials, key, or
account data, or cause `zagent` to act outside the user's intent.

## Scope & nature
zagent is an **unofficial** interoperability client. It reads **your own** local ZCode
credential store and drives **your own** installed runtime with **your own** account and
key — it ships no upstream binaries and sends nothing to third parties beyond your own
provider. It is **not affiliated with or endorsed by Z.ai**; for issues with the Z.ai
service itself, contact Z.ai. You are responsible for complying with your provider's
terms for your own account.

## Handling credentials
zagent never transmits your key or decrypted credentials anywhere except your own
configured provider endpoint. Never paste keys, tokens, or unredacted `doctor`/`quota`
output into issues or logs.
