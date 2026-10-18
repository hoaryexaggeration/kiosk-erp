# tests

Maps to the four architecture test areas. Where an area currently lives elsewhere, the pointer is noted.

| Folder | Purpose |
|---|---|
| `contract/` | API and OpenAPI contract tests (placeholders; contract behaviour is currently exercised in `apps/api/tests/integration`) |
| `sync-scenarios/` | Network fault / replay / conflict scenarios — currently `apps/api/tests/integration/sync-sale.spec.ts` and driven further in Phase 6+ |
| `acceptance/` | End-to-end retail workflows (receive stock → sell → credit → collect → pay supplier → close till) — Phase 8+ |

## Layers (§16)

1. **Domain unit tests** — `packages/domain-fixtures` + `apps/api/tests/unit`.
2. **Local database tests** — Android Room tests (Phase 3+); server constraints via API integration tests.
3. **API/contract tests** — `apps/api/tests/integration` (auth, idempotency, RBAC, validation).
4. **Cross-client conformance** — the same JSON fixtures run in TypeScript (now) and Kotlin/Swift (Phase 13).
5. **Sync fault-injection** — airplane mode, duplicate upload, timeout-after-commit (Phase 3+).
6. **End-to-end** — Phase 8+.
7. **Security/privacy** — tenant isolation, revoked device, permission escalation (partly covered).
8. **Field tests** — physical-phone checklist per phase (`docs/operations/phase-XX-apk-record.md`).
