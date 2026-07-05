## Testing Capabilities

**Strict TDD Mode**: disabled
**Detected**: 2026-06-08

### Test Runner

- Command: `bun test`
- Framework: Bun built-in test runner (no third-party framework)

### Test Layers

| Layer       | Available | Tool        |
| ----------- | --------- | ----------- |
| Unit        | ❌        | —           |
| Integration | ❌        | —           |
| E2E         | ❌        | —           |

### Coverage

- Available: ❌
- Command: —

### Quality Tools

| Tool         | Available | Command        |
| ------------ | --------- | -------------- |
| Linter       | ❌        | — (Prettier only, no ESLint) |
| Type checker | ✅        | `bun tsc --noEmit` (TypeScript strict mode) |
| Formatter    | ✅        | `bun run prettier --write` |

### Notes

- No test files exist in the project (only `src/llm/test/test-all-adapters.ts` which is a manual LLM adapter test script, not a unit test)
- `bun test` is available but will report "no tests found"
- Strict TDD not supported: no red-green-refactor cycle possible without tests
- TypeScript strict mode is enabled in tsconfig.json
- Prettier is configured with plugins for organize-imports and packagejson
