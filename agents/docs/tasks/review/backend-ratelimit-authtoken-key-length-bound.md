# BACKEND-RATELIMIT-AUTHTOKEN-KEY-LENGTH-BOUND — Bound the per-auth_token rate-limit key length

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of the signup-binding range — api-contract + kieran-ts P3 residual, pre-existing pattern)
**Priority:** P3 (pre-existing pattern; low impact)

## Context

The per-auth_token rate limiter added on `/confirm` and `/link` keys on `tok:${token}` where `token` comes straight from `req.body.auth_token` after only a `typeof === 'string' && length > 0` guard (`backend/src/routes/signup-verify.ts`, the `byAuthToken` key function). A client can supply an arbitrarily long `auth_token` string (bounded only by the 1MB body-parser limit), producing arbitrarily long rate-limiter keys (Redis keys, or in-memory map keys on the Redis-down fallback).

This mirrors a pre-existing pattern shared with the `byIp`-style key functions in the file; the signup-binding work surfaced it but did not introduce it. Impact is low (bounded by the body limit; each key still caps at 5 hits), but an attacker rotating long distinct tokens can inflate the key set.

## Goal

Cap the key length used by `byAuthToken` (and, if cheap, the sibling key functions): hash or truncate the token to a fixed-length key, or reject tokens longer than the real `auth_token` shape before they reach the limiter. A real `confirmed:` token is a fixed-length hex string, so a length/shape pre-validation also lets the limiter reject obviously-bogus tokens cheaply.

## Acceptance

- The rate-limit key derived from `auth_token` is fixed-length (hashed or shape-validated+truncated) regardless of the submitted token length.
- No regression to the per-token accumulation behavior (5/token/hour still accumulates for a real token).

## Non-goals

- Changing the rate-limit thresholds or the binding mechanism.
- A sweeping refactor of every key function unless trivially co-located.
