# SDD Init - BioAgents

## Project Context

**Project**: BioAgents
**Tech Stack**: Bun runtime, Elysia framework, Supabase (PostgreSQL), BullMQ/Redis (optional), Preact frontend
**Architecture**: Multi-agent system with Deep Research iterative workflow, LLM adapter pattern
**Persistence**: OpenSpec (file-based, repo files)
**Strict TDD**: Not supported (no test files exist)

## Stack Summary

| Component | Technology |
|-----------|------------|
| Runtime | Bun |
| Web Framework | Elysia |
| Database | Supabase (PostgreSQL) |
| Job Queue | BullMQ + Redis (optional, off by default) |
| Frontend | Preact |
| LLM Providers | OpenAI, Anthropic, Google, OpenRouter |
| Payments | x402 (Base/USDC), b402 (BNB/USDT) |
| Testing | `bun test` (no test files) |
| Quality | Prettier, TypeScript strict |

## Architecture Patterns

- **Agent-based**: planning, hypothesis, reflection, discovery, literature, analysis, reply, clarification, fileUpload, continueResearch
- **Layered routes**: routes → agents → services → db/storage
- **LLM adapter pattern**: multi-provider support via adapters
- **Deep Research workflow**: iterative human-AI collaboration with world state

## Testing Status

- Test runner: `bun test` available but NO test files found
- No unit, integration, or E2E tests
- Strict TDD: NOT supported

## Artifacts Created

- `openspec/config.yaml` - SDD configuration
- `openspec/testing-capabilities.md` - Testing capabilities
- `.atl/skill-registry.md` - Skill registry

## Next Recommended

Run `/sdd-explore` to begin exploring a change with the initialized SDD context.
