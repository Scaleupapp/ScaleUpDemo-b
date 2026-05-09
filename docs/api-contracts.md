# API Contracts (OpenAPI)

The single source of truth for request/response shapes between the backend
and clients (iOS, Android RN) lives in [`openapi.yaml`](../openapi.yaml).

## Why this exists

In Phase 4 (commit `00b7d2c` / `ae06b28`) the backend `/plan/current` endpoint
shipped with a response shape that did not match the iOS `PlanDTO` it was
meant to feed. iOS hit `DecodingError.keyNotFound` → "Couldn't load your plan"
on every app open. No CI step caught the drift because there was no contract
between the two repos. This file is that contract.

## When to update

Update `openapi.yaml` **in the same PR** as any of the following:

- A new HTTP endpoint
- A change to an existing endpoint's request body or response shape
- A change to a shared schema (e.g. `PlanCurrent`, `DiagnosticAttemptStart`)
- A new error code returned in a 409 / 4xx response

If your PR touches a wire shape and does not update this file, expect the
review to flag it.

## Generating typed clients

### iOS (Swift)

Use [swift-openapi-generator](https://github.com/apple/swift-openapi-generator).
Add a build-tool plugin to the `ScaleUp` target and reference this file.
The generated `Components.Schemas.PlanCurrent` replaces the hand-rolled
`PlanDTO` in `ScaleUp/Features/Plan/Services/PlanService.swift`.

### Android (TypeScript / RN)

Use [openapi-typescript](https://github.com/drwpow/openapi-typescript):

```bash
npx openapi-typescript ../scaleup-backend/openapi.yaml --output src/types/api.ts
```

Then import generated types in `src/services/*Service.ts` instead of
hand-rolled interfaces.

### Backend (Node)

Two options:
- **Runtime validation**: integrate `express-openapi-validator` to validate
  every request/response against this spec.
- **Test-time validation**: a Jest/node:test contract test that imports the
  spec and asserts each handler's responses against the schema. Lightweight,
  catches drift at PR time.

## Current coverage

Initial pass documents only the surfaces that surfaced bugs in the field:

- `POST /diagnostic/start` — incl. the structured 409 reason codes
- `GET /plan/status`
- `GET /plan/current`

Extend whenever you touch other endpoints. The goal is full coverage; we
just don't backfill all at once.
