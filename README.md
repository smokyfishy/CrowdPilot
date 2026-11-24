# CrowdPilot

Describe the DJ mix you want. CrowdPilot finds recordings that allow mixing, analyzes their beats, key and energy, and renders one continuous set with beat-matched transitions. Create a mix at `/mix`, follow its generation progress, and use Listen to replay the AI DJ's recorded performance, seek to tracks and transitions, or refine the mix.

Built with React and [DeepSpace](https://docs.deep.space) on Cloudflare Workers and Durable Objects.

- [System architecture: request flow, DeepSpace primitives, security](docs/ARCHITECTURE.md)
- [Mix generator architecture, provider policies and research mode](docs/AI_MIX_GENERATOR.md)
- [DJ engine and planning](docs/DJ_AI_ARCHITECTURE.md)
- [Research corpus and rights](docs/PROFESSIONAL_DJ_CORPUS_STATUS.md)

## Local development

Use Node 22.15+, 24, or 26 and npm 11.6+.

```sh
npm ci
npx deepspace auth login
npx deepspace dev start
```

The live catalog flow uses Jamendo. Configure secrets with `npx deepspace secrets`: `JAMENDO_CLIENT_ID` (required), `GROQ_API_KEY` (primary prompt interpreter; Claude through DeepSpace AI is the backup), `YOUTUBE_API_KEY` (discovery metadata), and `STEMS_QUEUE_URL` / `STEMS_BLOB_BASE` / `STEMS_BLOB_SAS` (optional Azure stem service, see `infra/stems`). See the [mix generator documentation](docs/AI_MIX_GENERATOR.md) for provider and test setup.

```sh
npm run type-check
npm run test:unit
npm run build
npx playwright test -c tests/playwright.config.ts tests/smoke.spec.ts tests/api.spec.ts
npx playwright test -c tests/playwright.config.ts tests/e2e/mixgen.spec.ts
```

The real-audio browser test requires a DeepSpace test account and access to the catalog. If Playwright misses files on Windows, run the tests from a worktree outside OneDrive.

GitHub is the source repository. Run `npx deepspace deploy` from the checked-out revision to publish a release.
