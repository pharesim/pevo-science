import nodemailer from 'nodemailer';
import { config } from '../config.js';

// Canonical SMTP transporter factory.
//
// Every site that needs to send mail in PEvO routes through this helper so
// each one gets the same 5-field shape (host/port/secure/auth + 4 timeout
// knobs). Direct calls to `nodemailer.createTransport` outside this module
// reopen the "missed third site" failure mode that occurred when /signup was
// left at nodemailer's defaults while the other two mail-sending routes had
// timeouts; a structural grep test in
// `tests/lib/smtp-helper-exhaustive-call-sites.test.ts` enforces the
// no-direct-call rule.
//
// Timeout rationale (all four matter):
//   - connectionTimeout (5s): TCP-connect ceiling. Nodemailer defaults to 2 minutes.
//   - socketTimeout (10s): per-read ceiling once the TCP connection is up.
//     Nodemailer defaults to unbounded socket reads.
//   - greetingTimeout (8s): bounds the SMTP banner + EHLO/HELO handshake.
//     A relay that completes the TCP handshake but never sends a 220 banner
//     would otherwise pin the request handler at the SMTP-protocol layer
//     until socketTimeout fires (10s) — but only if a read is in flight.
//     greetingTimeout is the explicit ceiling for the pre-EHLO read.
//   - dnsTimeout (5s): bounds DNS resolution of `host`. Without it, a stalled
//     resolver can pin the handler before any of the other timeouts fire,
//     because no socket exists yet for socketTimeout to measure.
//
// Per-stage ceilings: 5s DNS + 5s TCP connect + 8s SMTP banner + 10s socket
// read. Single-stage failure caps at the dominant stage (~10s, dominated by
// `socketTimeout`); a sequential cascade where every stage stalls to its
// ceiling totals up to 28s. Size upstream timeouts and circuit-breaker
// windows against the 28s sequential figure, not the ~10s single-stage
// figure.
//
// dns.lookup fallback caveat: `dnsTimeout: 5000` only bounds nodemailer's
// `dns.Resolver` (resolve4/resolve6) path. When that returns no usable
// addresses, nodemailer falls back to `dns.lookup()` inside its shared
// DNS-resolution helper — that call receives no timeout and runs on libuv's
// thread pool. Under degraded system DNS the fallback is the live path. The
// other timers eventually fire from different anchor points, so the gap is
// partial. If telemetry surfaces real `dns.lookup` pins, file a follow-up to
// wrap the helper with a custom `dnsResolver` or pre-flight
// `dns.promises.lookup(host, {timeout: 5000})`.
//
// See agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md
// for the full SMTP-failure oracle and timeout rationale.
export function createSmtpTransporter(): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    connectionTimeout: 5000,
    socketTimeout: 10000,
    greetingTimeout: 8000,
    dnsTimeout: 5000,
  });
}
