# ADR 0007 — Android module architecture

- **Status:** Accepted
- **Date:** 2026-10-18
- **Phase:** 3–4 (introduced; extended through Phase 12)

## Context

§5 of the architecture prescribes a multi-module Android project: shared `core` capabilities plus one
Gradle module per business domain (feature modules), with dependencies pointing inward. The first
buildable APK (Phase 3) was produced as a **single `:app` module** with packages mirroring the
prescribed feature structure, purely to get an APK gate met quickly. That was an explicit, logged
deviation.

By Phase 4 the app had grown to a catalogue, POS, inventory, sync, licensing and settings surfaces in
one module, and the deviation was re-raised with the owner, who chose to **perform the split now**,
before further feature work makes the move riskier.

## Decision

Adopt the §5 module graph:

```text
apps/android/
├── app/                    # composition root only: Application, MainActivity, DI container,
│                           # navigation host, theme, manifest
├── core/
│   ├── common/             # pure shared domain (money, pricing, small UI-agnostic utils)
│   ├── database/           # Room entities, DAOs, KioskDatabase (+ migrations)
│   ├── network/            # HTTP client and transport DTOs
│   ├── security/           # offline license verification (JOSE)
│   └── data/               # repositories, sync engine, session store
└── feature/
    ├── dashboard/  ├── pos/  ├── catalog/  ├── inventory/
    ├── sync/       ├── license/  └── settings/
```

Rules that make the boundary real rather than cosmetic:

- **Dependency direction is inward.** Feature modules depend on `core:*`; `core:*` never depends on a
  feature. `:app` depends on everything and is the only module that composes them.
- **Feature ViewModels never see the DI container.** `:app`'s `KioskViewModelFactory` supplies each
  ViewModel with the specific collaborators it needs, so a feature cannot reach into unrelated
  infrastructure.
- **Cross-module types are deliberate.** `:core:data` exposes `:core:common`, `:core:database` and
  `:core:network` via `api(...)` because their models appear in repository signatures; everything else
  is `implementation`.
- **No app types leak downward.** The default API base URL (an app `BuildConfig` concern) is injected
  into `SessionStore` by `:app` instead of being read from a `BuildConfig` the library cannot see.
- Versions live in a single **Gradle version catalog** (`gradle/libs.versions.toml`).

## Consequences

- **Positive:** boundaries are enforced by the compiler; incremental builds only recompile changed
  modules; a feature can be developed or tested in isolation; the layout now matches the architecture
  the project claims to implement.
- **Negative:** thirteen modules means thirteen (small) build files and a longer configuration phase
  on a cold build; convention plugins are an obvious next step if that becomes a pain point.
- **Neutral:** the Gradle/AGP/Kotlin versions are unchanged (AGP 8.5.2, Kotlin 1.9.24, Gradle 8.7);
  the Docker APK gate (ADR 0005) is unchanged apart from the module graph it builds.

## Compliance check

Preserves the mandated stack (Kotlin/Compose/Room/Gradle) and satisfies §5's module structure. The
earlier single-module deviation is now closed.
