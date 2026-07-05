# Skill Registry

## Project Skills

| Name | Trigger | Path | Scope |
|------|---------|------|-------|
| longevity-scholar | This skill should be used when users explicitly request academic papers, recent research, most cited research, or scholarly articles about longevity, aging, lifespan extension, or related topics. Triggers on phrases like "find papers on", "latest research about", "most cited studies on", or "academic literature about" in the context of longevity. | .claude/skills/longevity-scholar/SKILL.md | project |

## Agent Skills

| Name | Trigger | Path | Scope |
|------|---------|------|-------|
| skills (LLM) | LLM provider skills integration via Anthropic Claude Agent SDK | src/llm/skills/skills.ts | agent |

## Convention Files

| File | Description |
|------|-------------|
| CLAUDE.md | Project overview, tech stack, architecture, commands, deployment |
| documentation/docs/AUTH.md | Authentication (JWT, x402/b402 payments) |
| documentation/docs/SETUP.md | Environment setup and LLM configuration |
| documentation/docs/JOB_QUEUE.md | BullMQ queue system architecture |
| documentation/docs/FILE_UPLOAD.md | S3 presigned URL file upload flow |
