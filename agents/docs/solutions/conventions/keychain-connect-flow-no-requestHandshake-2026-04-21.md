---
title: "Hive Keychain wallet connect: signMessage alone, no requestHandshake"
date: 2026-04-21
category: conventions
module: frontend/src
problem_type: convention
component: hive_keychain
severity: medium
applies_when:
  - "Implementing or modifying the Hive Keychain connect/login flow"
  - "Adding a new page that needs to verify Keychain availability and account ownership"
  - "Debugging a Keychain connect flow that hangs, double-prompts, or fails silently"
tags: [hive-keychain, authentication, connect-flow, requestSignBuffer]
---

## Rule

In the wallet connect flow, do NOT call `requestHandshake()`. A `signMessage` call (which uses `requestSignBuffer` under the hood) is sufficient to (a) verify Keychain is installed and reachable, and (b) prove the user controls the claimed account.

## Why

`requestHandshake()` adds a separate extension round-trip that serves no purpose once `signMessage` is going to run anyway — the signature-verification step already proves Keychain presence and account ownership. Calling both caused double-prompts and a race where the handshake callback fired after the sign callback in some browser configurations, breaking the connect UI.

## How to apply

- `signMessage` (via `requestSignBuffer`) is the single source of truth for connect-flow success.
- Keychain availability is implicit: if `signMessage` rejects with "extension not found", surface that; otherwise proceed.
- Do not add a preliminary handshake "just to check" — that's exactly the pattern this rule exists to prevent.
