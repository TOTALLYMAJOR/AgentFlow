# Example contract-first backlog

## BL-100 - Define checkout contract

```yaml
estimate_hours: 4
depends_on: []
owns:
  - contracts/features/checkout/
validate:
  - npm run test -- contracts
produces:
  - name: checkout-api
    type: openapi
    version: 1.0.0
    path: contracts/features/checkout/openapi.yaml
```

Define the API, schemas, examples, and required UI states.

### Acceptance Criteria

- Success and failure examples are valid against the schema.
- Provider and consumer fixtures use version 1.0.0.

## BL-101 - Implement checkout provider

```yaml
estimate_hours: 7
depends_on:
  - BL-100
owns:
  - apps/api/src/checkout/
  - apps/api/test/checkout/
consumes:
  - task: BL-100
    artifact: checkout-api
    version: 1.0.0
produces:
  - name: checkout-provider
    type: service
    version: 1.0.0
```

Implement the backend against the integrated contract.

### Acceptance Criteria

- Provider verification passes every contract example.
- Invalid requests return the documented error shape.

## BL-102 - Implement checkout consumer

```yaml
estimate_hours: 6
depends_on:
  - BL-100
owns:
  - apps/web/src/features/checkout/
  - apps/web/test/checkout/
consumes:
  - task: BL-100
    artifact: checkout-api
    version: 1.0.0
produces:
  - name: checkout-consumer
    type: frontend
    version: 1.0.0
```

Implement the frontend against generated contract types and fixtures.

### Acceptance Criteria

- Loading, validation, declined, unavailable, and success states exist.
- Keyboard navigation works.

## BL-103 - Verify checkout interoperability

```yaml
estimate_hours: 3
depends_on:
  - BL-101
  - BL-102
owns:
  - tests/integration/checkout/
consumes:
  - task: BL-101
    artifact: checkout-provider
    version: 1.0.0
  - task: BL-102
    artifact: checkout-consumer
    version: 1.0.0
```

Run provider, consumer, and browser verification together.

### Acceptance Criteria

- An incompatible response fails before build completion.
- The corrected flow passes browser smoke validation.
